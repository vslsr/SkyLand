import {
  DEFAULT_PLAYER_MOVEMENT,
  PLAYER_BOUNDS,
  PLAYER_COLLISION_RADIUS,
  applyPlayerMovement,
  clampToPlayArea,
  createSpawnPoint,
  normalizeAngle,
  sanitizeMoveInput,
  toFiniteNumber,
} from '../../shared/playerMovement.mjs';
import {
  INPUT_TIME_BUDGET_SECONDS,
  MAXIMUM_INPUT_DELTA_SECONDS,
  MOVEMENT_IDLE_TIMEOUT_MS,
} from '../../shared/networkTuning.mjs';
import {
  ACTOR_CONTROL_COMPONENT,
  BUOYANCY_COMPONENT,
  CARGO_COMPONENT,
  ELASTIC_TETHER_COMPONENT,
  GENERATED_PROP_COMPONENT,
  INTERACTABLE_COMPONENT,
  INVENTORY_COMPONENT,
  ITEM_STACK_COMPONENT,
  SIMPLE_COLLISION_COMPONENT,
  TRANSFORM_COMPONENT,
  VESSEL_MOTOR_COMPONENT,
} from '../../shared/actor/index.mjs';
import { CollisionWorld } from '../../shared/collision/index.mjs';
import {
  createActorSnapshots,
  createServerActorWorld,
} from '../actors/ServerActorFactory.mjs';
import { ServerGeneratedPropActors } from '../actors/ServerGeneratedPropActors.mjs';
import { ServerPlayerActor } from '../actors/ServerPlayerActor.mjs';
import {
  addVesselCargo,
  damageVesselPart,
  removeVesselCargo,
} from '../actors/VesselStateMutations.mjs';
import {
  grabElasticTether,
  releaseElasticTether,
} from '../actors/ElasticTetherMutations.mjs';
import { ServerChunkColliders } from './ServerChunkColliders.mjs';
import { parseGeneratedPropId } from '../../shared/world/generatedProp.mjs';
import { toWorldSeed } from '../../shared/world/worldConfig.mjs';

function roundCoordinate(value) {
  return Math.round(value * 1000) / 1000;
}

const ACTOR_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function sanitizeActorId(value) {
  const id = String(value ?? '');
  if (id.length > 96) return undefined;
  return ACTOR_ID_PATTERN.test(id) ? id : undefined;
}

function resolvePlayerActorArchetype(definition) {
  const configuredId = definition.gameplay?.playerActor?.archetypeId;
  if (!configuredId) {
    return {
      id: 'player-slime',
      components: {
        playerMovement: DEFAULT_PLAYER_MOVEMENT,
        render: { model: 'line-art-player-slime', radius: PLAYER_COLLISION_RADIUS },
      },
    };
  }
  const archetype = definition.actorArchetypes?.find((candidate) => candidate.id === configuredId);
  if (!archetype?.components.playerMovement || archetype.components.render.model !== 'line-art-player-slime') {
    throw new Error(`场景缺少玩家 Actor 原型：${configuredId}`);
  }
  return archetype;
}

/**
 * 房间内的权威世界状态。
 *
 * 客户端提交的是「方向 + 加速开关 + 这段时间有多长」，而不是坐标；
 * 位置一律由这里用 shared/playerMovement 推进，所以速度上限、活动范围
 * 和朝向范围都握在服务端手上。
 */
export class ServerScene {
  constructor(sceneDefinition = { id: 'grassland' }, options = {}) {
    const definition = typeof sceneDefinition === 'string' ? { id: sceneDefinition } : sceneDefinition;
    this.id = definition.id;
    this.bounds = definition.gameplay?.bounds ?? PLAYER_BOUNDS;
    this.spawn = definition.gameplay?.spawn;
    this.playerActorArchetype = resolvePlayerActorArchetype(definition);
    this.worldSeed = toWorldSeed(options.worldSeed);
    this.players = new Map();
    // 一张空间网格同时承载 Actor 与流式世界的静态物件。玩家推出只查身边的
    // 几个格子，成本不随房间里的 Actor 数或世界面积增长。
    this.collision = new CollisionWorld();
    this.actorWorld = createServerActorWorld(definition, {
      players: this.players,
      collision: this.collision,
      worldSeed: this.worldSeed,
    });
    // 静态碰撞只有流式场景才有；固定摆放的场景里树是布景，没有碰撞体。
    this.chunkColliders = new ServerChunkColliders({
      world: this.collision,
      worldSeed: this.worldSeed,
      enabled: Boolean(definition.renderer?.world),
    });
    // 生成物件和静态碰撞一样跟着玩家滑动，房间启动时一个都不建。
    // 哪些种类真的产生 Actor，由场景的 gameplay.worldProps 绑定决定。
    this.generatedProps = new ServerGeneratedPropActors({
      world: this.actorWorld,
      archetypes: definition.actorArchetypes,
      worldProps: definition.gameplay?.worldProps,
      worldSeed: this.worldSeed,
      enabled: Boolean(definition.renderer?.world),
    });
    this.tick = 0;
    this.now = options.now ?? (() => Date.now());
    this.lastRefillAt = this.now();
  }

  addPlayer(player) {
    const spawn = createSpawnPoint(player.slot ?? this.players.size, this.spawn, this.bounds);
    const radius = this.playerActorArchetype.components.render.radius;
    const movement = this.playerActorArchetype.components.playerMovement;
    // 出生点是按槽位算的固定圆周，未必避得开树和石头；先把它推到碰撞外面，
    // 否则新玩家会卡在树干里，等第一条输入才被挤出来。
    this.chunkColliders.ensureAround(spawn.x, spawn.z);
    this.generatedProps.ensureAround(spawn.x, spawn.z);
    const placed = clampToPlayArea(
      this.collision.resolveCircle(spawn, radius, {
        verticalProfile: {
          minimumY: 0,
          maximumY: radius * 2,
          maximumStepHeight: movement.maximumStepHeight,
        },
      }),
      this.bounds,
    );
    const actor = new ServerPlayerActor(
      player,
      this.playerActorArchetype,
      placed,
      this.now(),
    );
    this.actorWorld.addActor(actor);
    this.players.set(player.id, actor);
  }

  removePlayer(playerId) {
    for (const actor of this.actorWorld.query(
      ELASTIC_TETHER_COMPONENT,
      INTERACTABLE_COMPONENT,
    )) {
      const tether = actor.requireComponent(ELASTIC_TETHER_COMPONENT);
      if (tether.holderPlayerId === playerId) {
        releaseElasticTether(tether, actor.requireComponent(INTERACTABLE_COMPONENT));
      }
    }
    this.players.delete(playerId);
    this.actorWorld.removeActor(playerId);
    for (const actor of this.actorWorld.query(ACTOR_CONTROL_COMPONENT)) {
      const control = actor.requireComponent(ACTOR_CONTROL_COMPONENT);
      if (control.ownerPlayerId === playerId) this.releaseActorControl(playerId, actor.id);
    }
  }

  /** 同一 Actor 同时只允许一个在线玩家控制；同一玩家也只能占用一艘船。 */
  claimActorControl(playerId, actorId) {
    if (!this.players.has(playerId)) return false;
    const actor = this.actorWorld.getActor(sanitizeActorId(actorId));
    const control = actor?.getComponent(ACTOR_CONTROL_COMPONENT);
    const motor = actor?.getComponent(VESSEL_MOTOR_COMPONENT);
    if (!control || !motor) return false;
    if (control.ownerPlayerId === playerId) return true;
    if (control.ownerPlayerId) return false;
    const alreadyOwned = this.actorWorld.query(ACTOR_CONTROL_COMPONENT).some((candidate) => (
      candidate.requireComponent(ACTOR_CONTROL_COMPONENT).ownerPlayerId === playerId
    ));
    if (alreadyOwned) return false;

    control.ownerPlayerId = playerId;
    control.resetInput();
    control.eventSequence = 0;
    control.revision += 1;
    motor.stopInput();
    return true;
  }

  releaseActorControl(playerId, actorId) {
    const actor = this.actorWorld.getActor(sanitizeActorId(actorId));
    const control = actor?.getComponent(ACTOR_CONTROL_COMPONENT);
    const motor = actor?.getComponent(VESSEL_MOTOR_COMPONENT);
    if (!control || control.ownerPlayerId !== playerId) return false;
    control.ownerPlayerId = null;
    control.resetInput();
    control.eventSequence = 0;
    control.revision += 1;
    motor?.stopInput();
    return true;
  }

  /** 校验序号与所有权后，仅写入意图；VesselMotorSystem 在固定 tick 中推进坐标。 */
  applyActorInput(playerId, message) {
    const actor = this.actorWorld.getActor(sanitizeActorId(message?.actorId));
    const control = actor?.getComponent(ACTOR_CONTROL_COMPONENT);
    const motor = actor?.getComponent(VESSEL_MOTOR_COMPONENT);
    if (!control || !motor || control.ownerPlayerId !== playerId) return false;
    const sequence = Math.floor(toFiniteNumber(message?.sequence, 0));
    if (sequence <= control.inputSequence) return false;
    control.inputSequence = sequence;
    control.lastInputAt = this.now();
    motor.throttle = clamp(toFiniteNumber(message?.throttle, 0), -1, 1);
    motor.steering = clamp(toFiniteNumber(message?.steering, 0), -1, 1);
    return true;
  }

  /** 通用 Actor 事件入口；当前落地载重增删和浮力部件损伤。 */
  applyActorEvent(playerId, message) {
    const actor = this.actorWorld.getActor(sanitizeActorId(message?.actorId));
    const control = actor?.getComponent(ACTOR_CONTROL_COMPONENT);
    const buoyancy = actor?.getComponent(BUOYANCY_COMPONENT);
    if (!control || !buoyancy || control.ownerPlayerId !== playerId) return false;
    const sequence = Math.floor(toFiniteNumber(message?.sequence, 0));
    if (sequence <= control.eventSequence) return false;
    const event = message?.event;
    if (!event || typeof event !== 'object') return false;

    let applied = false;
    if (event.type === 'cargo:add') {
      const cargoId = sanitizeActorId(event.cargoId);
      if (!cargoId) return false;
      applied = addVesselCargo(buoyancy, {
        id: cargoId,
        mass: clamp(toFiniteNumber(event.mass, 0), 0, 1000),
        localX: toFiniteNumber(event.localX, 0),
        localZ: toFiniteNumber(event.localZ, 0),
      });
    } else if (event.type === 'cargo:remove') {
      const cargoId = sanitizeActorId(event.cargoId);
      if (!cargoId) return false;
      applied = removeVesselCargo(buoyancy, cargoId);
    } else if (event.type === 'damage') {
      const partId = sanitizeActorId(event.partId);
      if (!partId) return false;
      applied = damageVesselPart(buoyancy, partId, toFiniteNumber(event.amount, 0));
    } else {
      return false;
    }
    if (!applied) return false;
    control.eventSequence = sequence;
    return true;
  }

  /** 场景交互入口；按动作分别使用权威玩家或权威载具坐标校验。 */
  interactWithActor(playerId, message) {
    const player = this.players.get(playerId);
    if (!player) return false;
    const sequence = Math.floor(toFiniteNumber(message?.sequence, 0));
    if (sequence <= player.actorInteractionSequence) return false;
    const target = this.actorWorld.getActor(sanitizeActorId(message?.actorId));
    const interactable = target?.getComponent(INTERACTABLE_COMPONENT);
    const targetTransform = target?.getComponent(TRANSFORM_COMPONENT);
    if (!target || !interactable?.enabled || !targetTransform) return false;

    if (interactable.action === 'mushroom-bite') {
      const tether = target.getComponent(ELASTIC_TETHER_COMPONENT);
      if (!tether) return false;
      const distance = Math.hypot(
        targetTransform.x - player.x,
        targetTransform.z - player.z,
      );
      if (distance > interactable.maximumDistance) return false;
      if (!grabElasticTether(tether, interactable, player, targetTransform)) return false;
      player.actorInteractionSequence = sequence;
      return true;
    }

    if (interactable.action === 'pickup-stack') {
      const stack = target.getComponent(ITEM_STACK_COMPONENT);
      if (!stack) return false;
      const distance = Math.hypot(targetTransform.x - player.x, targetTransform.z - player.z);
      if (distance > interactable.maximumDistance) return false;
      const pickedUp = this.actorWorld.context.highCountActors?.pickup(this.actorWorld, target.id, player) ?? 0;
      if (pickedUp <= 0) return false;
      player.actorInteractionSequence = sequence;
      return true;
    }

    if (interactable.action === 'harvest-prop') {
      const prop = target.getComponent(GENERATED_PROP_COMPONENT);
      // Actor 只可能由服务端从世界种子推导出来，所以 Component 本身就是权威；
      // 这一步只是确认自描述 id 与它描述的东西没有对不上。
      const identity = parseGeneratedPropId(target.id);
      if (
        !prop
        || !identity
        || identity.kind !== prop.kind
        || identity.chunkX !== prop.chunkX
        || identity.chunkZ !== prop.chunkZ
        || identity.propIndex !== prop.propIndex
      ) return false;
      const distance = Math.hypot(targetTransform.x - player.x, targetTransform.z - player.z);
      if (distance > interactable.maximumDistance) return false;
      if (!prop.applyDamage()) return false;
      // 立刻登记偏离态：这一片 chunk 卸载再装回来时，它要保持被采过的样子。
      this.generatedProps.recordDeviation(target);
      interactable.revision += 1;
      if (prop.removed) {
        interactable.enabled = false;
        this.chunkColliders.setPropSkipped(prop.chunkX, prop.chunkZ, prop.propIndex, true);
        if (prop.dropArchetypeId) {
          this.spawnItemStack(prop.dropArchetypeId, {
            position: [targetTransform.x, Math.max(0.5, prop.scale * 0.55), targetTransform.z],
            quantity: prop.dropQuantity,
            velocity: [0, 2.2, 0],
            yaw: targetTransform.yaw,
          });
        }
      }
      player.actorInteractionSequence = sequence;
      return true;
    }

    if (interactable.action !== 'cargo-toggle') return false;
    const cargo = target.getComponent(CARGO_COMPONENT);
    if (!cargo) return false;

    const vessel = this.actorWorld.query(
      ACTOR_CONTROL_COMPONENT,
      BUOYANCY_COMPONENT,
      TRANSFORM_COMPONENT,
    ).find((actor) => (
      actor.requireComponent(ACTOR_CONTROL_COMPONENT).ownerPlayerId === playerId
    ));
    if (!vessel) return false;
    const vesselTransform = vessel.requireComponent(TRANSFORM_COMPONENT);
    if (cargo.carrierActorId && cargo.carrierActorId !== vessel.id) return false;
    const distance = Math.hypot(
      targetTransform.x - vesselTransform.x,
      targetTransform.z - vesselTransform.z,
    );
    if (distance > interactable.maximumDistance) return false;

    const buoyancy = vessel.requireComponent(BUOYANCY_COMPONENT);
    let applied;
    if (!cargo.carrierActorId) {
      applied = addVesselCargo(buoyancy, {
        id: target.id,
        mass: cargo.mass,
        localX: cargo.mountLocalX,
        localZ: cargo.mountLocalZ,
      });
      if (applied) {
        try {
          this.actorWorld.setActorParent(target.id, vessel.id, { worldPositionStays: true });
          targetTransform.setLocalTransform([
            cargo.mountLocalX,
            cargo.mountLocalY,
            cargo.mountLocalZ,
          ], 0);
          cargo.carrierActorId = vessel.id;
        } catch (error) {
          removeVesselCargo(buoyancy, target.id);
          throw error;
        }
      }
    } else {
      applied = removeVesselCargo(buoyancy, target.id);
      if (applied) {
        this.actorWorld.setActorParent(target.id, undefined, { worldPositionStays: true });
        cargo.carrierActorId = null;
        const sideOffset = buoyancy.minimumBeam * 0.5 + 1;
        const x = clamp(
          vesselTransform.x + Math.cos(vesselTransform.yaw) * sideOffset,
          this.bounds.minimumX,
          this.bounds.maximumX,
        );
        const z = clamp(
          vesselTransform.z - Math.sin(vesselTransform.yaw) * sideOffset,
          this.bounds.minimumZ,
          this.bounds.maximumZ,
        );
        targetTransform.setWorldTransform(
          [x, this.actorWorld.context.seaLevel, z],
          vesselTransform.yaw + 0.18,
        );
      }
    }
    if (!applied) return false;
    cargo.revision += 1;
    interactable.revision += 1;
    player.actorInteractionSequence = sequence;
    return true;
  }

  /**
   * 校验并应用一条输入。位移在收到消息时立即结算，
   * 这样客户端按真实帧时间做的预测才能和服务端对齐。
   */
  applyInput(playerId, message) {
    const player = this.players.get(playerId);
    if (!player) return;

    // 序号必须严格递增，重放和乱序到达的旧输入一律丢弃。
    const sequence = Math.floor(toFiniteNumber(message?.sequence, 0));
    if (sequence <= player.sequence) return;
    player.sequence = sequence;

    // 客户端报的时长不可信：先钳制单条上限，再从服务器时钟维护的
    // 时间预算里扣除，谎报时长最多只能提前花光预算，不能凭空加速。
    const requested = Math.max(
      0,
      Math.min(toFiniteNumber(message?.deltaSeconds, 0), MAXIMUM_INPUT_DELTA_SECONDS),
    );
    const granted = Math.min(requested, player.timeBudget);
    player.timeBudget -= granted;

    player.yaw = normalizeAngle(toFiniteNumber(message?.yaw, player.yaw));

    const move = sanitizeMoveInput({ ...message?.move, sprint: message?.sprint === true });
    const next = applyPlayerMovement(
      { x: player.x, z: player.z },
      move,
      granted,
      this.bounds,
      player.movement,
    );
    // 玩家可能刚加入或刚跨过边界，先确认脚下这一片的静态碰撞体已经就位，
    // 否则这一步会从树里穿过去，再被下一个 tick 拉回来。
    this.chunkColliders.ensureAround(next.x, next.z);
    this.generatedProps.ensureAround(next.x, next.z);
    const resolved = clampToPlayArea(
      this.collision.resolveCircle(next, player.collisionRadius, {
        verticalProfile: {
          minimumY: player.y,
          maximumY: player.y + player.collisionHeight,
          maximumStepHeight: player.movement.maximumStepHeight,
        },
      }),
      this.bounds,
    );
    const distance = Math.hypot(resolved.x - player.x, resolved.z - player.z);
    player.setPosition(resolved.x, resolved.z);
    player.speed = granted > 0 ? distance / granted : 0;
    player.lastInputAt = this.now();
  }

  /** 按真实经过的时间补充每名玩家的模拟时间预算。 */
  update() {
    this.tick += 1;
    const now = this.now();
    const elapsedSeconds = Math.max(0, (now - this.lastRefillAt) / 1000);
    this.lastRefillAt = now;

    for (const player of this.players.values()) {
      player.timeBudget = Math.min(
        INPUT_TIME_BUDGET_SECONDS,
        player.timeBudget + elapsedSeconds,
      );
      if (now - player.lastInputAt > MOVEMENT_IDLE_TIMEOUT_MS) player.speed = 0;
    }
    // Actor 的碰撞盒由 ActorColliderIndex 在 tick 内同步，这里不用再管。
    this.actorWorld.update(elapsedSeconds, now / 1000);
    // 常驻的静态碰撞与生成物件都跟着玩家走；没人跨过 chunk 边界时直接返回。
    this.chunkColliders.sync(this.players.values());
    this.generatedProps.sync(this.players.values());
  }

  /** 树木、矿脉或战利品系统调用这一入口生成一个可自动合并的物品堆。 */
  spawnItemStack(archetypeId, options = {}) {
    return this.actorWorld.context.highCountActors.spawn(
      this.actorWorld,
      archetypeId,
      options,
      this.now() / 1000,
    );
  }

  createSnapshot(viewerPlayerId) {
    const viewer = viewerPlayerId ? this.players.get(viewerPlayerId) : undefined;
    return {
      sceneId: this.id,
      tick: this.tick,
      serverTime: this.now(),
      actors: createActorSnapshots(this.actorWorld, { viewer }),
      players: Array.from(this.players.values(), (player) => ({
        id: player.id,
        name: player.name,
        x: roundCoordinate(player.x),
        z: roundCoordinate(player.z),
        yaw: roundCoordinate(player.yaw),
        speed: roundCoordinate(player.speed),
        sequence: player.sequence,
        inventory: player.requireComponent(INVENTORY_COMPONENT).snapshot(),
        inventoryRevision: player.requireComponent(INVENTORY_COMPONENT).revision,
      })),
    };
  }
}
