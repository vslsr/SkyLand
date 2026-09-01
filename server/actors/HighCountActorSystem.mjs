import {
  ACTOR_RESIDENCY_COMPONENT,
  COMBUSTIBLE_COMPONENT,
  DROP_MOTION_COMPONENT,
  INTERACTABLE_COMPONENT,
  ITEM_STACK_COMPONENT,
  LIFETIME_COMPONENT,
  TEMPERATURE_COMPONENT,
  TRANSFORM_COMPONENT,
} from '../../shared/actor/index.mjs';
import { CHUNK_SIZE } from '../../shared/world/worldConfig.mjs';

const DEFAULT_ACTIVE_BUDGET = 256;
const DEFAULT_TRANSITION_BUDGET = 32;
const DEFAULT_MAXIMUM_PILES_PER_CHUNK = 16;
const MERGE_CELL_SIZE = 2;

function chunkCoordinate(value) {
  return Math.floor(value / CHUNK_SIZE);
}

function chunkKey(chunkX, chunkZ) {
  return `${chunkX}:${chunkZ}`;
}

function isNearAnyPlayer(players, chunkX, chunkZ, radiusChunks) {
  for (const player of players?.values?.() ?? []) {
    if (
      Math.abs(chunkCoordinate(player.x) - chunkX) <= radiusChunks
      && Math.abs(chunkCoordinate(player.z) - chunkZ) <= radiusChunks
    ) return true;
  }
  return false;
}

function pushExpiry(heap, entry) {
  heap.push(entry);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (heap[parent].expiresAt <= entry.expiresAt) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = entry;
}

function popExpiry(heap) {
  const first = heap[0];
  const tail = heap.pop();
  if (heap.length > 0) {
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= heap.length) break;
      const right = left + 1;
      const child = right < heap.length && heap[right].expiresAt < heap[left].expiresAt ? right : left;
      if (heap[child].expiresAt >= tail.expiresAt) break;
      heap[index] = heap[child];
      index = child;
    }
    heap[index] = tail;
  }
  return first;
}

function serializeActor(actor) {
  const transform = actor.requireComponent(TRANSFORM_COMPONENT);
  const stack = actor.requireComponent(ITEM_STACK_COMPONENT);
  const residency = actor.requireComponent(ACTOR_RESIDENCY_COMPONENT);
  const lifetime = actor.requireComponent(LIFETIME_COMPONENT);
  const temperature = actor.getComponent(TEMPERATURE_COMPONENT);
  const combustible = actor.getComponent(COMBUSTIBLE_COMPONENT);
  return {
    id: actor.id,
    archetypeId: actor.archetypeId,
    transform: { position: [transform.x, transform.y, transform.z], yaw: transform.yaw },
    quantity: stack.quantity,
    residencyState: residency.state,
    stateAgeSeconds: residency.stateAgeSeconds,
    spawnedAt: lifetime.spawnedAt,
    expiresAt: lifetime.expiresAt,
    temperature: temperature?.temperature,
    fuel: combustible?.fuel,
    burning: combustible?.burning ?? false,
  };
}

/**
 * 高数量 Actor 的服务端预算器。
 *
 * Actor 只在玩家 AOI 附近常驻；稳定且远离玩家的对象序列化进按 chunk 分组的
 * dormant record。记录没有 System update、碰撞体或快照条目，玩家靠近时才恢复。
 */
export class HighCountActorSystem {
  constructor(options = {}) {
    this.activeBudget = options.activeBudget ?? DEFAULT_ACTIVE_BUDGET;
    this.transitionBudget = options.transitionBudget ?? DEFAULT_TRANSITION_BUDGET;
    this.maximumPilesPerChunk = options.maximumPilesPerChunk ?? DEFAULT_MAXIMUM_PILES_PER_CHUNK;
    this.dormantByChunk = new Map();
    this.dormantIds = new Map();
    this.expiryHeap = [];
    this.pendingRemovalIds = new Set();
    this.nextId = 1;
  }

  get dormantCount() {
    return this.dormantIds.size;
  }

  spawn(world, archetypeId, options = {}, elapsedSeconds = 0) {
    const archetype = world.context.archetypes?.get(archetypeId);
    if (!archetype?.components.itemStack) throw new Error(`原型不是高数量堆叠 Actor：${archetypeId}`);
    const id = options.id ?? `drop-${(this.nextId++).toString(36)}`;
    if (world.getActor(id) || this.findDormantRecord(id)) throw new Error(`Actor id 重复：${id}`);
    const position = options.position ?? [0, 0, 0];
    const actor = world.context.createActor({
      id,
      archetypeId,
      localTransform: { position, yaw: options.yaw ?? 0 },
    }, archetype, {
      spawnedAt: elapsedSeconds,
      itemStack: { quantity: options.quantity },
      dropMotion: { velocity: options.velocity },
    });
    world.addActor(actor);
    return actor;
  }

  pickup(world, actorId, player) {
    const actor = world.getActor(actorId);
    const stack = actor?.getComponent(ITEM_STACK_COMPONENT);
    const inventory = player?.getComponent('inventory');
    if (!actor || !stack || !inventory || stack.quantity <= 0) return 0;
    const quantity = inventory.add(stack.itemType, stack.quantity);
    if (quantity <= 0) return 0;
    stack.remove(quantity);
    if (stack.quantity === 0) this.removeResident(world, actor.id);
    return quantity;
  }

  update(world, deltaSeconds, elapsedSeconds) {
    this.pendingRemovalIds.clear();
    this.materializeNearPlayers(world, elapsedSeconds);
    const actors = world.query(
      TRANSFORM_COMPONENT,
      ITEM_STACK_COMPONENT,
      ACTOR_RESIDENCY_COMPONENT,
      DROP_MOTION_COMPONENT,
      LIFETIME_COMPONENT,
    );
    let activeCount = 0;
    const expired = [];
    for (const actor of actors) {
      if (this.pendingRemovalIds.has(actor.id)) continue;
      const lifetime = actor.requireComponent(LIFETIME_COMPONENT);
      if (elapsedSeconds >= lifetime.expiresAt) {
        expired.push(actor.id);
        continue;
      }
      const residency = actor.requireComponent(ACTOR_RESIDENCY_COMPONENT);
      const combustible = actor.getComponent(COMBUSTIBLE_COMPONENT);
      if (combustible?.burning) {
        residency.setState('active');
        residency.stateAgeSeconds = 0;
      }
      if (residency.state === 'active') {
        activeCount += 1;
        this.integrateActive(world, actor, deltaSeconds);
        if (activeCount > this.activeBudget && !combustible?.burning) {
          const transform = actor.requireComponent(TRANSFORM_COMPONENT);
          const motion = actor.requireComponent(DROP_MOTION_COMPONENT);
          const groundY = world.context.groundHeightAt?.(transform.x, transform.z) ?? 0;
          transform.setWorldTransform([transform.x, groundY + motion.radius, transform.z], transform.yaw);
          motion.velocityX = 0;
          motion.velocityY = 0;
          motion.velocityZ = 0;
          residency.setState('sleeping');
        }
      } else {
        residency.stateAgeSeconds += deltaSeconds;
      }
    }
    for (const actorId of expired) this.removeResident(world, actorId);
    this.mergeSleeping(world);
    this.dematerializeFarSleeping(world);
    this.expireDormant(elapsedSeconds);
  }

  integrateActive(world, actor, deltaSeconds) {
    const transform = actor.requireComponent(TRANSFORM_COMPONENT);
    const motion = actor.requireComponent(DROP_MOTION_COMPONENT);
    const residency = actor.requireComponent(ACTOR_RESIDENCY_COMPONENT);
    const delta = Math.max(0, Math.min(deltaSeconds, 0.1));
    const currentGroundY = world.context.groundHeightAt?.(transform.x, transform.z) ?? 0;
    const groundLevel = currentGroundY + motion.radius;
    const restingBeforeStep = (
      transform.y <= groundLevel + 1e-4
      && Math.abs(motion.velocityY) <= motion.settleSpeed
    );
    const damping = Math.exp(-(restingBeforeStep ? motion.groundDrag : motion.drag) * delta);
    motion.velocityX *= damping;
    motion.velocityZ *= damping;
    motion.velocityY -= motion.gravity * delta;
    let x = transform.x + motion.velocityX * delta;
    let y = transform.y + motion.velocityY * delta;
    let z = transform.z + motion.velocityZ * delta;
    const groundY = (world.context.groundHeightAt?.(x, z) ?? 0) + motion.radius;
    let restingOnGround = false;
    if (y <= groundY) {
      y = groundY;
      const reboundSpeed = Math.max(0, -motion.velocityY) * motion.restitution;
      // 离散步长下，静止球每帧也会先被重力拉出一个很小的负速度；把这部分
      // 数值抖动纳入阈值，否则恢复系数会让它永远在地面上微弹、无法 sleep。
      const bounceThreshold = Math.max(
        motion.settleSpeed,
        motion.gravity * delta * motion.restitution * 1.1,
      );
      if (reboundSpeed > bounceThreshold) {
        motion.velocityY = reboundSpeed;
      } else {
        motion.velocityY = 0;
        restingOnGround = true;
      }
    }

    // 球形掉落物只查询当前位置附近的空间格。果实落地以后会撞开树干、石头和
    // 其它掉落物；推出方向同时作为接触法线，用恢复系数反射水平速度。
    if (motion.radius > 0 && world.context.collision) {
      const resolved = world.context.collision.resolveCircle({ x, z }, motion.radius, {
        accept: (candidate) => candidate.actor !== actor,
        verticalProfile: {
          minimumY: y - motion.radius,
          maximumY: y + motion.radius,
          maximumStepHeight: 0,
        },
      });
      const pushX = resolved.x - x;
      const pushZ = resolved.z - z;
      const pushLength = Math.hypot(pushX, pushZ);
      if (pushLength > 1e-7) {
        const normalX = pushX / pushLength;
        const normalZ = pushZ / pushLength;
        const inwardSpeed = motion.velocityX * normalX + motion.velocityZ * normalZ;
        if (inwardSpeed < 0) {
          const impulse = -(1 + motion.restitution) * inwardSpeed;
          motion.velocityX += normalX * impulse;
          motion.velocityZ += normalZ * impulse;
        }
        x = resolved.x;
        z = resolved.z;
      }
    }

    const bounds = world.context.bounds;
    if (bounds) {
      const minimumX = bounds.minimumX + motion.radius;
      const maximumX = bounds.maximumX - motion.radius;
      const minimumZ = bounds.minimumZ + motion.radius;
      const maximumZ = bounds.maximumZ - motion.radius;
      const boundedX = Math.max(minimumX, Math.min(maximumX, x));
      const boundedZ = Math.max(minimumZ, Math.min(maximumZ, z));
      if (boundedX !== x) motion.velocityX *= -motion.restitution;
      if (boundedZ !== z) motion.velocityZ *= -motion.restitution;
      x = boundedX;
      z = boundedZ;
    }

    if (restingOnGround) {
      motion.groundedSeconds += delta;
    } else {
      motion.groundedSeconds = 0;
    }
    transform.setWorldTransform([x, y, z], transform.yaw);
    const speed = Math.hypot(motion.velocityX, motion.velocityY, motion.velocityZ);
    if (
      !actor.getComponent(COMBUSTIBLE_COMPONENT)?.burning
      && motion.groundedSeconds >= residency.sleepDelaySeconds
      && speed <= motion.settleSpeed
    ) {
      motion.velocityX = 0;
      motion.velocityY = 0;
      motion.velocityZ = 0;
      residency.setState('sleeping');
    }
  }

  mergeSleeping(world) {
    const buckets = new Map();
    const removed = new Set();
    const actors = world.query(TRANSFORM_COMPONENT, ITEM_STACK_COMPONENT, ACTOR_RESIDENCY_COMPONENT);
    for (const actor of actors) {
      if (this.pendingRemovalIds.has(actor.id)) continue;
      const residency = actor.requireComponent(ACTOR_RESIDENCY_COMPONENT);
      if (residency.state !== 'sleeping' || actor.getComponent(COMBUSTIBLE_COMPONENT)?.burning) continue;
      const transform = actor.requireComponent(TRANSFORM_COMPONENT);
      const cellX = Math.floor(transform.x / MERGE_CELL_SIZE);
      const cellZ = Math.floor(transform.z / MERGE_CELL_SIZE);
      let merged = false;
      for (let offsetX = -1; offsetX <= 1 && !merged; offsetX += 1) {
        for (let offsetZ = -1; offsetZ <= 1 && !merged; offsetZ += 1) {
          for (const target of buckets.get(`${cellX + offsetX}:${cellZ + offsetZ}`) ?? []) {
            if (removed.has(target.id) || this.pendingRemovalIds.has(target.id)) continue;
            const sourceStack = actor.requireComponent(ITEM_STACK_COMPONENT);
            const targetStack = target.requireComponent(ITEM_STACK_COMPONENT);
            if (!targetStack.isCompatible(sourceStack) || targetStack.remainingCapacity === 0) continue;
            const targetTransform = target.requireComponent(TRANSFORM_COMPONENT);
            const mergeRadius = Math.max(0.1, target.getComponent('simpleCollision')?.halfWidth ?? 0.75) * 2.5;
            if (Math.hypot(transform.x - targetTransform.x, transform.z - targetTransform.z) > mergeRadius) continue;
            const targetQuantity = targetStack.quantity;
            const sourceQuantity = sourceStack.quantity;
            const accepted = targetStack.add(sourceQuantity);
            if (accepted > 0) this.mergePersistentState(target, actor, targetQuantity, sourceQuantity, accepted);
            sourceStack.remove(accepted);
            if (sourceStack.quantity === 0) {
              removed.add(actor.id);
              this.removeResident(world, actor.id);
              merged = true;
            }
          }
        }
      }
      if (!merged) {
        const key = `${cellX}:${cellZ}`;
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = [];
          buckets.set(key, bucket);
        }
        bucket.push(actor);
      }
    }

    // 正常半径合并后仍超过 chunk 软上限时，按物品兼容键做过载聚合。
    // 这条路径只在爆量时触发，牺牲部分掉落位置精度来保持 Actor 数量上界。
    const chunkGroups = new Map();
    for (const actor of actors) {
      if (removed.has(actor.id) || this.pendingRemovalIds.has(actor.id)) continue;
      const residency = actor.requireComponent(ACTOR_RESIDENCY_COMPONENT);
      if (residency.state !== 'sleeping' || actor.getComponent(COMBUSTIBLE_COMPONENT)?.burning) continue;
      const transform = actor.requireComponent(TRANSFORM_COMPONENT);
      const stack = actor.requireComponent(ITEM_STACK_COMPONENT);
      const key = `${chunkKey(chunkCoordinate(transform.x), chunkCoordinate(transform.z))}:${stack.itemType}:${stack.compatibilityKey}`;
      let group = chunkGroups.get(key);
      if (!group) {
        group = [];
        chunkGroups.set(key, group);
      }
      group.push(actor);
    }
    for (const group of chunkGroups.values()) {
      if (group.length <= this.maximumPilesPerChunk) continue;
      const targets = group.slice(0, this.maximumPilesPerChunk);
      for (const source of group.slice(this.maximumPilesPerChunk)) {
        const sourceStack = source.requireComponent(ITEM_STACK_COMPONENT);
        for (const target of targets) {
          const targetStack = target.requireComponent(ITEM_STACK_COMPONENT);
          if (!targetStack.isCompatible(sourceStack) || targetStack.remainingCapacity === 0) continue;
          const targetQuantity = targetStack.quantity;
          const sourceQuantity = sourceStack.quantity;
          const accepted = targetStack.add(sourceQuantity);
          if (accepted > 0) this.mergePersistentState(target, source, targetQuantity, sourceQuantity, accepted);
          sourceStack.remove(accepted);
          if (sourceStack.quantity === 0) {
            removed.add(source.id);
            this.removeResident(world, source.id);
            break;
          }
        }
      }
    }
  }

  mergePersistentState(target, source, targetQuantity, sourceQuantity, acceptedQuantity) {
    const totalQuantity = targetQuantity + acceptedQuantity;
    const targetTemperature = target.getComponent(TEMPERATURE_COMPONENT);
    const sourceTemperature = source.getComponent(TEMPERATURE_COMPONENT);
    if (targetTemperature && sourceTemperature && totalQuantity > 0) {
      targetTemperature.temperature = (
        targetTemperature.temperature * targetQuantity
        + sourceTemperature.temperature * acceptedQuantity
      ) / totalQuantity;
      targetTemperature.revision += 1;
    }
    const targetFuel = target.getComponent(COMBUSTIBLE_COMPONENT);
    const sourceFuel = source.getComponent(COMBUSTIBLE_COMPONENT);
    if (targetFuel && sourceFuel && sourceQuantity > 0) {
      const fraction = acceptedQuantity / sourceQuantity;
      const transferredMaximumFuel = sourceFuel.maximumFuel * fraction;
      const transferredFuel = sourceFuel.fuel * fraction;
      targetFuel.maximumFuel += transferredMaximumFuel;
      targetFuel.fuel += transferredFuel;
      sourceFuel.maximumFuel -= transferredMaximumFuel;
      sourceFuel.fuel -= transferredFuel;
      targetFuel.revision += 1;
      sourceFuel.revision += 1;
    }
    const targetLifetime = target.getComponent(LIFETIME_COMPONENT);
    const sourceLifetime = source.getComponent(LIFETIME_COMPONENT);
    if (targetLifetime && sourceLifetime) {
      targetLifetime.expiresAt = Math.max(targetLifetime.expiresAt, sourceLifetime.expiresAt);
    }
  }

  dematerializeFarSleeping(world) {
    let remaining = this.transitionBudget;
    for (const actor of world.query(TRANSFORM_COMPONENT, ITEM_STACK_COMPONENT, ACTOR_RESIDENCY_COMPONENT)) {
      if (remaining <= 0) break;
      if (this.pendingRemovalIds.has(actor.id)) continue;
      const residency = actor.requireComponent(ACTOR_RESIDENCY_COMPONENT);
      if (
        residency.state !== 'sleeping'
        || !residency.dormantEligible
        || residency.stateAgeSeconds < residency.dormantDelaySeconds
        || actor.getComponent(COMBUSTIBLE_COMPONENT)?.burning
      ) continue;
      const transform = actor.requireComponent(TRANSFORM_COMPONENT);
      const policy = actor.getComponent('replicationPolicy');
      const radius = (policy?.radiusChunks ?? 2) + 1;
      const cx = chunkCoordinate(transform.x);
      const cz = chunkCoordinate(transform.z);
      if (isNearAnyPlayer(world.context.players, cx, cz, radius)) continue;
      const record = serializeActor(actor);
      let records = this.dormantByChunk.get(chunkKey(cx, cz));
      if (!records) {
        records = new Map();
        this.dormantByChunk.set(chunkKey(cx, cz), records);
      }
      records.set(actor.id, record);
      record.chunkKey = chunkKey(cx, cz);
      this.dormantIds.set(actor.id, record);
      if (Number.isFinite(record.expiresAt)) pushExpiry(this.expiryHeap, record);
      this.removeResident(world, actor.id);
      remaining -= 1;
    }
  }

  materializeNearPlayers(world, elapsedSeconds) {
    let remaining = this.transitionBudget;
    const visitedChunks = new Set();
    let materializeRadius = 3;
    for (const archetype of world.context.archetypes?.values?.() ?? []) {
      const policy = archetype.components.replicationPolicy;
      if (policy?.mode === 'aoi') materializeRadius = Math.max(materializeRadius, policy.radiusChunks + 1);
    }
    for (const player of world.context.players?.values?.() ?? []) {
      const centerX = chunkCoordinate(player.x);
      const centerZ = chunkCoordinate(player.z);
      for (let offsetX = -materializeRadius; offsetX <= materializeRadius && remaining > 0; offsetX += 1) {
        for (let offsetZ = -materializeRadius; offsetZ <= materializeRadius && remaining > 0; offsetZ += 1) {
          const key = chunkKey(centerX + offsetX, centerZ + offsetZ);
          if (visitedChunks.has(key)) continue;
          visitedChunks.add(key);
          const records = this.dormantByChunk.get(key);
          if (!records) continue;
          for (const record of Array.from(records.values())) {
            if (remaining <= 0) break;
            records.delete(record.id);
            this.dormantIds.delete(record.id);
            if (elapsedSeconds < record.expiresAt) world.addActor(this.restoreActor(world, record));
            remaining -= 1;
          }
          if (records.size === 0) this.dormantByChunk.delete(key);
        }
      }
    }
  }

  restoreActor(world, record) {
    const archetype = world.context.archetypes.get(record.archetypeId);
    const lifetimeSeconds = Number.isFinite(record.expiresAt)
      ? Math.max(0, record.expiresAt - record.spawnedAt)
      : 0;
    const actor = world.context.createActor({
      id: record.id,
      archetypeId: record.archetypeId,
      localTransform: record.transform,
    }, archetype, {
      spawnedAt: record.spawnedAt,
      lifetime: { lifetimeSeconds },
      itemStack: { quantity: record.quantity },
      actorResidency: { state: record.residencyState },
      thermal: record,
    });
    actor.requireComponent(ACTOR_RESIDENCY_COMPONENT).stateAgeSeconds = record.stateAgeSeconds;
    return actor;
  }

  expireDormant(elapsedSeconds) {
    let remaining = this.transitionBudget;
    while (
      remaining > 0
      && this.expiryHeap.length > 0
      && this.expiryHeap[0].expiresAt <= elapsedSeconds
    ) {
      const candidate = popExpiry(this.expiryHeap);
      const record = this.dormantIds.get(candidate.id);
      if (record === candidate) {
        this.dormantIds.delete(record.id);
        const records = this.dormantByChunk.get(record.chunkKey);
        records?.delete(record.id);
        if (records?.size === 0) this.dormantByChunk.delete(record.chunkKey);
      }
      remaining -= 1;
    }
  }

  removeResident(world, actorId) {
    if (this.pendingRemovalIds.has(actorId)) return false;
    this.pendingRemovalIds.add(actorId);
    world.context.collision?.removeDynamic(actorId);
    return world.removeActor(actorId);
  }

  findDormantRecord(actorId) {
    return this.dormantIds.get(actorId);
  }
}
