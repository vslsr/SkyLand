import {
  DEFAULT_PLAYER_MOVEMENT,
  PLAYER_BOUNDS,
  PLAYER_COLLISION_RADIUS,
  clampToPlayArea,
  createSpawnPoint,
  normalizeAngle,
  sanitizeMoveInput,
  separateSpawnFromPlayers,
  toFiniteNumber,
} from '../../shared/playerMovement.mjs';
import {
  INPUT_STEP_BUDGET_CATCH_UP_RATE,
  INPUT_TIME_BUDGET_SECONDS,
  MAXIMUM_INPUT_STEPS_PER_PACKET,
  MOVEMENT_IDLE_TIMEOUT_MS,
  SIMULATION_STEP_SECONDS,
} from '../../shared/networkTuning.mjs';
import {
  ACTOR_CONTROL_COMPONENT,
  BUOYANCY_COMPONENT,
  BuoyancyComponent,
  CARGO_COMPONENT,
  CONTAINER_COMPONENT,
  DROP_MOTION_COMPONENT,
  ELASTIC_DETACH_COMPONENT,
  ELASTIC_TETHER_COMPONENT,
  GENERATED_PROP_COMPONENT,
  INTERACTABLE_COMPONENT,
  INVENTORY_COMPONENT,
  ITEM_STACK_COMPONENT,
  PICKUP_DROP_COMPONENT,
  BITE_COMPONENT,
  SOFT_BODY_DEFORMATION_COMPONENT,
  sampleBuoyancyBobOffset,
  SIMPLE_COLLISION_COMPONENT,
  TRANSFORM_COMPONENT,
  VESSEL_MOTOR_COMPONENT,
} from '../../shared/actor/index.mjs';
import { itemCatalog } from '../../shared/items/index.mjs';
import { CollisionWorld } from '../../shared/collision/index.mjs';
import {
  createActorSnapshots,
  createServerActorWorld,
} from '../actors/ServerActorFactory.mjs';
import { ServerGeneratedPropActors } from '../actors/ServerGeneratedPropActors.mjs';
import { ServerPlayerActor } from '../actors/ServerPlayerActor.mjs';
import { isPlayerRenderModel } from '../actors/ActorCatalog.mjs';
import {
  addVesselCargo,
  damageVesselPart,
  removeVesselCargo,
} from '../actors/VesselStateMutations.mjs';
import {
  grabElasticTether,
  releaseElasticTether,
} from '../actors/ElasticTetherMutations.mjs';
import { dropPickedActor, pickupActor } from '../actors/PickupDropMutations.mjs';
import {
  dropHeldObject,
  dropInventoryItem,
  stowHeldItem,
  syncHeldItemActor,
  transferItems,
  useHeldItem,
} from '../actors/InventoryMutations.mjs';
import { PlayerIdleSimulation } from './PlayerIdleSimulation.mjs';
import { ServerChunkColliders } from './ServerChunkColliders.mjs';
import { ServerTerrainColliders } from './ServerTerrainColliders.mjs';
import { PhysicsWorld, getRapier } from '../../shared/physics/index.mjs';
import { stepCharacter } from '../../shared/physics/stepCharacter.mjs';
import { parseGeneratedPropId } from '../../shared/world/generatedProp.mjs';
import {
  fruitDropWorldPosition,
  selectFruitDropAnchors,
} from '../../shared/world/fruitDrop.mjs';
import { toWorldSeed } from '../../shared/world/worldConfig.mjs';
import { SceneEnvironmentDirector } from './SceneEnvironmentDirector.mjs';
import { TERRAIN_CELL_SIZE, TERRAIN_SURFACE } from '../../shared/world/terrainConfig.mjs';
import { sampleTerrain } from '../../shared/world/terrainContent.mjs';
import { TerrainEditor } from '../../shared/world/terrainEditing.mjs';
import { TerrainPatchStore } from '../../shared/world/terrainPatches.mjs';
import {
  isSlimeDragRegrab,
  MAX_SOFT_BODY_HOLDERS,
  mouthWorld,
  sanitizeSlimeDragState,
} from '../../shared/softBodyDeformation.mjs';
import { terrainMovementHeight } from '../../shared/world/terrainMovement.mjs';

function roundCoordinate(value) {
  return Math.round(value * 1000) / 1000;
}

/** 形变状态进快照前统一取整；两个来源（鼠标拖拽与咬住）用同一份精度。 */
function roundSlimeDrag(drag) {
  return {
    revision: drag.revision,
    contactX: roundCoordinate(drag.contactX),
    contactY: roundCoordinate(drag.contactY),
    contactZ: roundCoordinate(drag.contactZ),
    pullX: roundCoordinate(drag.pullX),
    pullY: roundCoordinate(drag.pullY),
    pullZ: roundCoordinate(drag.pullZ),
  };
}

function capturePlayerTransformDebugState(player) {
  return {
    transform: {
      x: player.x,
      y: player.y,
      z: player.z,
      yaw: player.yaw,
    },
    velocity: {
      x: player.characterState.vx,
      y: player.characterState.vy,
      z: player.characterState.vz,
    },
    grounded: player.characterState.grounded,
    ackTick: player.ackTick,
    stepBudget: player.stepBudget,
  };
}

const ACTOR_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/;

/** 玩家能编辑到的最远距离（米）。和交互一样按权威坐标校验。 */
const TERRAIN_EDIT_RANGE = 12;

/** 放下物件时留在玩家身体之外的额外余量（米）。 */
const DROP_CLEARANCE_MARGIN = 0.08;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function sanitizeActorId(value) {
  const id = String(value ?? '');
  if (id.length > 96) return undefined;
  return ACTOR_ID_PATTERN.test(id) ? id : undefined;
}

/** 上行的物品 id 必须是目录里登记过的一条，否则整条命令按无效处理。 */
function sanitizeItemType(value) {
  const id = String(value ?? '');
  return itemCatalog.has(id) ? id : undefined;
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
  const renderModel = archetype?.components.render.model;
  if (!archetype?.components.playerMovement || !isPlayerRenderModel(renderModel)) {
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
    this.rapier = options.rapier ?? getRapier();
    this.physics = new PhysicsWorld(this.rapier);
    this.bounds = definition.gameplay?.bounds ?? PLAYER_BOUNDS;
    this.spawn = definition.gameplay?.spawn;
    this.playerActorArchetype = resolvePlayerActorArchetype(definition);
    this.worldSeed = toWorldSeed(options.worldSeed);
    this.terrainEnabled = Boolean(definition.renderer?.world);
    // 地形编辑的权威副本。共享层的采样入口都接受 cellCodeAt 覆盖，所以只要
    // 把这一个函数传下去，移动、出生点和掉落落地就都走编辑后的地形。
    this.terrainPatches = this.terrainEnabled ? new TerrainPatchStore(this.worldSeed) : undefined;
    this.terrainEditor = this.terrainPatches
      ? new TerrainEditor(this.terrainPatches, { seaLevel: definition.gameplay?.water?.seaLevel ?? 0 })
      : undefined;
    this.terrainCellCodeAt = this.terrainPatches
      ? (globalCellX, globalCellZ) => this.terrainPatches.cellCodeAt(globalCellX, globalCellZ)
      : undefined;
    this.fixedWaterWorld = definition.renderer?.content?.ocean === true
      && definition.renderer?.content?.ground === false;
    if (!this.terrainEnabled && definition.renderer?.content?.ground !== false) {
      this.physics.setActorCollider('__fixed-ground', {
        shape: 'box',
        halfWidth: (this.bounds.maximumX - this.bounds.minimumX) * 0.5,
        halfLength: (this.bounds.maximumZ - this.bounds.minimumZ) * 0.5,
        minimumY: -0.2,
        maximumY: 0,
        x: (this.bounds.minimumX + this.bounds.maximumX) * 0.5,
        y: 0,
        z: (this.bounds.minimumZ + this.bounds.maximumZ) * 0.5,
        yaw: 0,
      });
    }
    this.now = options.now ?? (() => Date.now());
    this.playerTransformDebug = options.playerTransformDebug;
    this.players = new Map();
    // 天气与昼夜都是房间级权威状态：客户端只能提出合法请求，推进由这里完成。
    this.environment = new SceneEnvironmentDirector(definition.environment, {
      seed: this.worldSeed,
    });
    // 一张空间网格同时承载 Actor 与流式世界的静态物件。玩家推出只查身边的
    // 几个格子，成本不随房间里的 Actor 数或世界面积增长。
    this.collision = new CollisionWorld();
    this.actorWorld = createServerActorWorld(definition, {
      players: this.players,
      collision: this.collision,
      physics: this.physics,
      worldSeed: this.worldSeed,
      groundHeightAt: this.terrainEnabled
        ? (x, z) => sampleTerrain(this.worldSeed, x, z, {}, this.terrainCellCodeAt).groundY
        : undefined,
    });
    // 静态碰撞只有流式场景才有；固定摆放的场景里树是布景，没有碰撞体。
    this.chunkColliders = new ServerChunkColliders({
      world: this.collision,
      physics: this.physics,
      worldSeed: this.worldSeed,
      enabled: Boolean(definition.renderer?.world),
    });
    this.terrainColliders = new ServerTerrainColliders({
      physics: this.physics,
      worldSeed: this.worldSeed,
      enabled: Boolean(definition.renderer?.world),
      cellCodeAt: this.terrainCellCodeAt,
      terrainPatches: this.terrainPatches,
      onTerrainChanged: () => this.liftPlayersAboveTerrain(),
    });
    // 生成物件和静态碰撞一样跟着玩家滑动，房间启动时一个都不建。
    // 哪些种类真的产生 Actor、同 kind 如何分配原型，由 gameplay.worldProps 决定。
    this.generatedProps = new ServerGeneratedPropActors({
      world: this.actorWorld,
      archetypes: definition.actorArchetypes,
      worldProps: definition.gameplay?.worldProps,
      worldSeed: this.worldSeed,
      enabled: Boolean(definition.renderer?.world),
      now: () => this.now() / 1000,
    });
    // 输入停了权威模拟不能跟着停：重力、坠落与落水由这里按房间时钟补步。
    this.idleSimulation = new PlayerIdleSimulation({
      stepPlayer: (player, input) => this.stepPlayerOnce(player, input),
      preparePlayer: (player) => {
        this.chunkColliders.ensureAround(player.x, player.z);
        this.terrainColliders.ensureAround(player.x, player.z);
        this.generatedProps.ensureAround(player.x, player.z);
        this.actorWorld.context.refreshActorColliders?.();
        this.physics.setCharacterTranslation(player.id, player.characterState);
      },
    });
    this.tick = 0;
    this.lastRefillAt = this.now();
  }

  addPlayer(player) {
    const spawn = createSpawnPoint(player.slot ?? this.players.size, this.spawn, this.bounds);
    const radius = this.playerActorArchetype.components.render.radius;
    const movement = this.playerActorArchetype.components.playerMovement;
    const buoyancy = this.playerActorArchetype.components.buoyancy
      ? new BuoyancyComponent(this.playerActorArchetype.components.buoyancy)
      : undefined;
    // 出生点是按槽位算的固定圆周，未必避得开树和石头；先把它推到碰撞外面，
    // 否则新玩家会卡在树干里，等第一条输入才被挤出来。
    this.chunkColliders.ensureAround(spawn.x, spawn.z);
    this.terrainColliders.ensureAround(spawn.x, spawn.z);
    this.generatedProps.ensureAround(spawn.x, spawn.z);
    this.actorWorld.context.refreshActorColliders?.();
    const spawnGroundY = this.terrainEnabled
      ? terrainMovementHeight(
          sampleTerrain(this.worldSeed, spawn.x, spawn.z, {}, this.terrainCellCodeAt),
          this.actorWorld.context.seaLevel,
          buoyancy?.draft,
        )
      : 0;
    // 玩家彼此实心，出生点也必须避开已经在场的人，否则新玩家一进来就卡在别人身体里。
    const playerPlaced = separateSpawnFromPlayers(spawn, radius, this.players.values());
    const collisionPlaced = this.collision.resolveCircle(playerPlaced, radius, {
      verticalProfile: {
        minimumY: spawnGroundY,
        maximumY: spawnGroundY + radius * 2,
        maximumStepHeight: movement.maximumStepHeight,
      },
    });
    const boundedPlaced = clampToPlayArea(collisionPlaced, this.bounds);
    const placed = this.terrainEnabled
      ? {
          ...boundedPlaced,
          y: terrainMovementHeight(
            sampleTerrain(
              this.worldSeed,
              boundedPlaced.x,
              boundedPlaced.z,
              {},
              this.terrainCellCodeAt,
            ),
            this.actorWorld.context.seaLevel,
            buoyancy?.draft,
          ),
        }
      : { ...boundedPlaced, y: 0 };
    const actor = new ServerPlayerActor(
      player,
      this.playerActorArchetype,
      placed,
      this.now(),
    );
    actor.setPosition(
      actor.x,
      actor.z,
      this.playerVerticalHeightAt(actor, actor.x, actor.z, this.now() / 1000),
    );
    actor.characterParams.bounds = this.bounds;
    this.physics.createCharacter(player.id, {
      x: actor.x,
      y: actor.y,
      z: actor.z,
      radius: actor.collisionRadius,
      halfHeight: actor.collisionHeight * 0.5,
    });
    this.physics.prepareQueries();
    this.actorWorld.addActor(actor);
    this.players.set(player.id, actor);
    actor.syncWaterMovementEffect(this.isWaterAt(actor.x, actor.z));
  }

  removePlayer(playerId) {
    this.#clearBitesOf(playerId);
    this.dropCarriedActorsOf(playerId);
    for (const actor of this.actorWorld.query(
      ELASTIC_TETHER_COMPONENT,
      INTERACTABLE_COMPONENT,
    )) {
      const tether = actor.requireComponent(ELASTIC_TETHER_COMPONENT);
      if (tether.holderPlayerId === playerId) {
        releaseElasticTether(tether, actor.requireComponent(INTERACTABLE_COMPONENT));
      }
    }
    this.physics.removeCharacter(playerId);
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
  /** 这名玩家正叼着的那一株；嘴里同时只允许有一个。 */
  findCarriedActorId(playerId) {
    return this.players.get(playerId)?.getComponent(PICKUP_DROP_COMPONENT)?.heldActorId ?? undefined;
  }

  /**
   * 放下叼着的物件：不给任何冲量，就在离手的姿态上变成自由刚体。落地是躺是立
   * 完全由叼住时的姿态决定，而叼着时它是横衔的。
   *
   * 落点要放到身前，不能就地松口。嘴的位置来自玩家 PickupDrop Component，
   * 而玩家半径加物件半径要 0.7m 才不重叠：就地放下等于把它塞进自己身体里，
   * 玩家会当场被自己刚放下的东西顶住走不动，看起来像根本没松口。
   */
  dropCarriedActor(player, actor) {
    const pickupDrop = player?.getComponent(PICKUP_DROP_COMPONENT);
    if (pickupDrop?.heldActorId !== actor?.id) return false;
    if (!dropPickedActor(this.actorWorld, player)) return false;
    const interactable = actor.getComponent(INTERACTABLE_COMPONENT);
    // 脱落后的蘑菇仍是可拾取物。叼住期间临时关闭交互，放下或玩家离房时
    // 必须重新打开，否则下一位（包括重进房间的同一玩家）只能看到却捡不起。
    if (interactable && !interactable.enabled) {
      interactable.enabled = true;
      interactable.revision += 1;
    }
    const motion = actor.getComponent(DROP_MOTION_COMPONENT);
    const transform = actor.getComponent(TRANSFORM_COMPONENT);
    if (!motion || !transform) return true;
    if (player) {
      const clearance = player.collisionRadius + motion.radius + DROP_CLEARANCE_MARGIN;
      transform.setWorldTransform([
        player.x + Math.sin(player.yaw) * clearance,
        transform.y,
        player.z + Math.cos(player.yaw) * clearance,
      ], transform.yaw);
    }
    this.physics.createDynamicActor(actor.id, {
      x: transform.x,
      y: transform.y + motion.radius,
      z: transform.z,
      radius: motion.radius,
      linearDamping: motion.drag,
      angularDamping: motion.angularDamping,
      restitution: motion.restitution,
      friction: motion.groundDrag,
      rotation: {
        x: motion.rotationX, y: motion.rotationY, z: motion.rotationZ, w: motion.rotationW,
      },
    });
    this.physics.setDynamicActorVelocity(actor.id, { x: 0, y: 0, z: 0 });
    return true;
  }

  /** 把已经脱落、落在地上的蘑菇重新叼起。 */
  carryDetachedActor(player, actor, detachable, interactable) {
    const pickupDrop = player?.getComponent(PICKUP_DROP_COMPONENT);
    if (!detachable.detached || !pickupDrop || pickupDrop.heldActorId) return false;
    if (!pickupActor(this.actorWorld, actor, player)) return false;
    this.physics.removeDynamicActor(actor.id);
    if (interactable.enabled) {
      interactable.enabled = false;
      interactable.revision += 1;
    }
    return true;
  }

  /** 玩家离开房间时，嘴里那一株原地落下，不能跟着连接一起消失。 */
  dropCarriedActorsOf(playerId) {
    const actorId = this.findCarriedActorId(playerId);
    if (!actorId) return false;
    const actor = this.actorWorld.getActor(actorId);
    return this.dropCarriedActor(this.players.get(playerId), actor);
  }

  /**
   * 采一次。E 采集与手持工具使用走的是同一处，否则「砍一下」会有两套语义：
   * 一套改血量、一套改冷却，改了其中一套另一套不知道。
   *
   * @param {number} [damage] 工具给的额外力度；不传就是徒手的默认伤害。
   */
  harvestProp(target, prop, interactable, targetTransform, damage) {
    // 可再生的在冷却里会被 harvest 拒掉，不需要在这里单独判一次。
    const harvested = damage === undefined || prop.regrowable
      ? prop.harvest(this.now() / 1000)
      : prop.applyDamage(damage);
    if (!harvested) return false;
    // 立刻登记偏离态：这一片 chunk 卸载再装回来时，它要保持被采过的样子。
    this.generatedProps.recordDeviation(target);
    interactable.revision += 1;
    if (prop.removed) {
      // 采完就永久消失：几何体与静态碰撞一起撤走。可再生的什么都不动——
      // 树还在原地，只是暂时没果子。
      interactable.enabled = false;
      this.chunkColliders.setPropSkipped(prop.chunkX, prop.chunkZ, prop.propIndex, true);
    }
    // 可再生的每采一次都掉东西；掉血的只在采完那一下掉。
    if ((prop.removed || prop.regrowable) && prop.dropArchetypeId) {
      this.spawnGeneratedPropDrop(prop, targetTransform);
    }
    return true;
  }

  /** 手持工具够得着的那个可采集物件；没有就是这一下敲空了。 */
  findHarvestablePropNear(player) {
    let best;
    let bestDistance = Infinity;
    for (const actor of this.actorWorld.query(
      GENERATED_PROP_COMPONENT,
      INTERACTABLE_COMPONENT,
      TRANSFORM_COMPONENT,
    )) {
      const interactable = actor.requireComponent(INTERACTABLE_COMPONENT);
      if (!interactable.enabled || interactable.action !== 'harvest-prop') continue;
      const transform = actor.requireComponent(TRANSFORM_COMPONENT);
      const distance = Math.hypot(transform.x - player.x, transform.z - player.z);
      if (distance > interactable.maximumDistance || distance >= bestDistance) continue;
      best = actor;
      bestDistance = distance;
    }
    return best;
  }

  applyToolHarvest(player, target, damage) {
    return this.harvestProp(
      target,
      target.requireComponent(GENERATED_PROP_COMPONENT),
      target.requireComponent(INTERACTABLE_COMPONENT),
      target.requireComponent(TRANSFORM_COMPONENT),
      damage,
    );
  }

  removeItemStackActor(actorId) {
    this.actorWorld.context.highCountActors?.removeResident(this.actorWorld, actorId);
  }

  /**
   * 背包、快捷栏与容器的唯一上行入口。
   *
   * 合成一条消息而不是四条，是因为它们共享同一套前置校验（玩家在不在、序号有没有
   * 回退），并且都以「改完权威 Component、让下一帧快照去确认」收尾。传输层因此只
   * 需要认识一个 case。
   */
  applyInventoryCommand(playerId, message) {
    const player = this.players.get(playerId);
    if (!player) return false;
    const sequence = Math.floor(toFiniteNumber(message?.sequence, 0));
    if (sequence <= player.inventoryCommandSequence) return false;
    const command = message?.command;
    const inventory = player.getComponent(INVENTORY_COMPONENT);
    if (!command || !inventory) return false;

    let changed = false;
    switch (command.kind) {
      case 'hold':
        // 界面里点一下某件物品：放上快捷栏并立刻握在手上。
        changed = inventory.holdItemType(sanitizeItemType(command.itemType));
        break;
      case 'select':
        changed = inventory.setActiveHotbarSlot(Math.trunc(toFiniteNumber(command.slotIndex, -1)));
        break;
      case 'cycle':
        changed = inventory.cycleActiveHotbarSlot(toFiniteNumber(command.direction, 1));
        break;
      case 'assign':
        changed = inventory.assignHotbarSlot(
          Math.trunc(toFiniteNumber(command.slotIndex, -1)),
          sanitizeItemType(command.itemType),
        );
        break;
      case 'use:begin':
        // 蓄力的起点记在服务端：结算时用的是这个时刻，客户端报多久不作数。
        player.heldItemUseStartedAt = this.now();
        changed = true;
        break;
      case 'use:cancel':
        player.heldItemUseStartedAt = undefined;
        changed = true;
        break;
      case 'use:release': {
        const startedAt = player.heldItemUseStartedAt;
        player.heldItemUseStartedAt = undefined;
        if (startedAt === undefined) return false;
        changed = useHeldItem(this, player, (this.now() - startedAt) / 1000);
        break;
      }
      case 'drop':
        changed = dropHeldObject(this, player);
        break;
      case 'drop:stack':
        // 背包里那一堆直接丢一个到地上，不经过手：菜单里的「丢弃」指的是包里
        // 那件东西，不该顺手把手上握着的换掉。
        changed = dropInventoryItem(this, player, sanitizeItemType(command.itemType), 1);
        break;
      case 'stow:begin':
        // 交互键按住的起点。和蓄力一样记在服务端：客户端那圈转盘转满那一刻，
        // 就是这里判定长按那一刻，但判定用的是自己的计时。
        player.heldItemStowStartedAt = this.now();
        changed = true;
        break;
      case 'stow:cancel':
        player.heldItemStowStartedAt = undefined;
        changed = true;
        break;
      case 'stow:release': {
        const startedAt = player.heldItemStowStartedAt;
        player.heldItemStowStartedAt = undefined;
        if (startedAt === undefined) return false;
        // 短按放下、长按收回背包，分界来自玩家原型，两端读同一份。
        // 长按收不进去（背包满了，或这件东西根本揣不走）就回退成放下——按住半秒
        // 之后什么都不发生，玩家只会以为键失灵了。
        changed = (this.now() - startedAt) / 1000 >= inventory.stowHoldSeconds
          && stowHeldItem(this, player);
        if (!changed) changed = dropHeldObject(this, player);
        break;
      }
      case 'container:open':
      case 'container:close':
      case 'container:transfer':
        changed = this.applyContainerCommand(player, command);
        break;
      default:
        return false;
    }
    if (!['use:release', 'drop', 'drop:stack', 'stow:release'].includes(command.kind)) {
      // 换手要跟着快捷栏走；使用与丢下已经在各自的变更里对齐过了。
      syncHeldItemActor(this, player);
    }
    player.inventoryCommandSequence = sequence;
    return changed;
  }

  applyContainerCommand(player, command) {
    const actor = this.actorWorld.getActor(sanitizeActorId(command.actorId));
    const container = actor?.getComponent(CONTAINER_COMPONENT);
    const transform = actor?.getComponent(TRANSFORM_COMPONENT);
    if (!container || !transform) return false;
    // 够不着就当作没开：距离用权威位姿算，客户端算的只是预期。
    const distance = Math.hypot(transform.x - player.x, transform.z - player.z);
    if (command.kind === 'container:close') return container.closeFor(player.id);
    if (distance > container.reach) return false;
    if (command.kind === 'container:open') return container.openFor(player.id);
    return transferItems(player, actor, {
      itemType: sanitizeItemType(command.itemType),
      quantity: toFiniteNumber(command.quantity, 0),
      direction: command.direction === 'withdraw' ? 'withdraw' : 'store',
    }) > 0;
  }

  /** 走远的人自动退出容器；不依赖客户端自觉发关闭。 */
  updateContainerViewers() {
    for (const actor of this.actorWorld.query(CONTAINER_COMPONENT, TRANSFORM_COMPONENT)) {
      const container = actor.requireComponent(CONTAINER_COMPONENT);
      if (container.viewerPlayerIds.size === 0) continue;
      const transform = actor.requireComponent(TRANSFORM_COMPONENT);
      for (const viewerId of [...container.viewerPlayerIds]) {
        const viewer = this.players.get(viewerId);
        if (!viewer) {
          container.closeFor(viewerId);
          continue;
        }
        const distance = Math.hypot(transform.x - viewer.x, transform.z - viewer.z);
        if (distance > container.reach) container.closeFor(viewerId);
      }
    }
  }

  interactWithActor(playerId, message) {
    const player = this.players.get(playerId);
    if (!player) return false;
    const sequence = Math.floor(toFiniteNumber(message?.sequence, 0));
    if (sequence <= player.actorInteractionSequence) return false;
    const target = this.actorWorld.getActor(sanitizeActorId(message?.actorId));
    const interactable = target?.getComponent(INTERACTABLE_COMPONENT);
    const targetTransform = target?.getComponent(TRANSFORM_COMPONENT);
    if (!target || !interactable || !targetTransform) return false;

    // 叼着和拉着的那一株，interactable 已经关掉了；再按一次交互键说的是
    // 「放下」或「取消」，所以这两条要走在 enabled 检查之前。
    if (interactable.action === 'mushroom-bite') {
      const tether = target.getComponent(ELASTIC_TETHER_COMPONENT);
      const detachable = target.getComponent(ELASTIC_DETACH_COMPONENT);
      const pickupDrop = player.getComponent(PICKUP_DROP_COMPONENT);
      if (!tether) return false;
      if (pickupDrop?.heldActorId === target.id) {
        if (!this.dropCarriedActor(player, target)) return false;
        player.actorInteractionSequence = sequence;
        return true;
      }
      if (tether.holderPlayerId === playerId) {
        if (!releaseElasticTether(tether, interactable)) return false;
        player.actorInteractionSequence = sequence;
        return true;
      }
      if (!interactable.enabled) return false;
      // 嘴里已经有一株就不能再叼，否则手上那株会失去唯一的放下入口。
      if (!pickupDrop || pickupDrop.heldActorId) return false;
      const distance = Math.hypot(
        targetTransform.x - player.x,
        targetTransform.z - player.z,
      );
      if (distance > interactable.maximumDistance) return false;
      if (detachable?.detached) {
        if (!this.carryDetachedActor(player, target, detachable, interactable)) return false;
        player.actorInteractionSequence = sequence;
        return true;
      }
      if (!grabElasticTether(tether, interactable, player, targetTransform)) return false;
      player.actorInteractionSequence = sequence;
      return true;
    }

    if (!interactable.enabled) return false;

    if (interactable.action === 'pickup-stack') {
      const stack = target.getComponent(ITEM_STACK_COMPONENT);
      if (!stack) return false;
      const distance = Math.hypot(targetTransform.x - player.x, targetTransform.z - player.z);
      if (distance > interactable.maximumDistance) return false;
      const pickedUp = this.actorWorld.context.highCountActors?.pickup(this.actorWorld, target.id, player) ?? 0;
      if (pickedUp <= 0) return false;
      // 捡到的正好是快捷栏配置着的那一种时，手上要立刻出现它——空着手的那一格
      // 补上货就该自动握住，不需要玩家再点一次。
      syncHeldItemActor(this, player);
      player.actorInteractionSequence = sequence;
      return true;
    }

    if (interactable.action === 'container-open') {
      const container = target.getComponent(CONTAINER_COMPONENT);
      if (!container) return false;
      const distance = Math.hypot(targetTransform.x - player.x, targetTransform.z - player.z);
      if (distance > interactable.maximumDistance) return false;
      // 再按一次是关上：和「手上那件」同一条规矩，一个已经建立的持续状态必须有一
      // 个确定的退出入口。走远也会关，但那条由 updateContainerViewers 负责。
      if (!(container.isOpenFor(playerId)
        ? container.closeFor(playerId)
        : container.openFor(playerId))) return false;
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
      if (!this.harvestProp(target, prop, interactable, targetTransform)) return false;
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
   * 应用一次地形编辑，返回被改动的格子供房间广播。
   *
   * 距离用**权威玩家坐标**和格心算，客户端报哪一格都无所谓：够不到就不生效。
   * 编辑范围还必须落在活动区内，否则玩家能改到自己永远走不到的世界边缘。
   *
   * @returns {Array<{ cellX: number, cellZ: number, code: number }>} 空数组表示没生效
   */
  editTerrain(playerId, message) {
    const player = this.players.get(playerId);
    if (!player || !this.terrainEditor) return [];
    const sequence = Math.floor(toFiniteNumber(message?.sequence, 0));
    if (sequence <= player.terrainEditSequence) return [];

    const cellX = Math.floor(toFiniteNumber(message?.cellX, Number.NaN));
    const cellZ = Math.floor(toFiniteNumber(message?.cellZ, Number.NaN));
    if (!Number.isInteger(cellX) || !Number.isInteger(cellZ)) return [];
    const centerX = (cellX + 0.5) * TERRAIN_CELL_SIZE;
    const centerZ = (cellZ + 0.5) * TERRAIN_CELL_SIZE;
    if (Math.hypot(centerX - player.x, centerZ - player.z) > TERRAIN_EDIT_RANGE) return [];
    if (
      centerX < this.bounds.minimumX || centerX > this.bounds.maximumX
      || centerZ < this.bounds.minimumZ || centerZ > this.bounds.maximumZ
    ) return [];

    let changed = false;
    try {
      changed = this.applyTerrainOperation(cellX, cellZ, message?.operation);
    } catch {
      // 越界高度、未知形状之类由编辑器抛出。这些都是无效请求，不是服务器故障。
      return [];
    }
    player.terrainEditSequence = sequence;
    if (!changed) return [];

    // 注意：树和石头的静态碰撞盒来自放置记录里的 y_mm，那是**基础地形**的高度，
    // 不跟着 patch 走。所以在物件脚下改地形，物件会浮起或陷进去。要修就得让
    // 两端都用 patch 后的地形重算物件 y，那是另一件事，先记在这里。
    return [{ cellX, cellZ, code: this.terrainPatches.cellCodeAt(cellX, cellZ) }];
  }

  /** @returns {boolean} 覆盖层有没有真的改变 */
  applyTerrainOperation(cellX, cellZ, operation) {
    switch (operation) {
      case 'raise': return this.terrainEditor.raise(cellX, cellZ, 1);
      case 'lower': return this.terrainEditor.lower(cellX, cellZ, 1);
      case 'flatten': return this.terrainEditor.flatten(cellX, cellZ);
      case 'water': return this.terrainEditor.flood(cellX, cellZ);
      case 'ground': return this.terrainEditor.setSurface(cellX, cellZ, TERRAIN_SURFACE.GROUND);
      case 'reset': return this.terrainEditor.reset(cellX, cellZ);
      default: return false;
    }
  }

  liftPlayersAboveTerrain() {
    if (!this.terrainEnabled) return 0;
    let lifted = 0;
    for (const player of this.players.values()) {
      const groundY = sampleTerrain(
        this.worldSeed,
        player.x,
        player.z,
        {},
        this.terrainCellCodeAt,
      ).groundY;
      if (groundY <= player.y + 1e-6) continue;
      player.setPosition(player.x, player.z, groundY);
      player.characterState.vy = 0;
      player.characterState.grounded = true;
      this.physics.setCharacterTranslation(player.id, player.characterState);
      lifted += 1;
    }
    return lifted;
  }

  /** 房间新成员加入时用来补齐已有编辑。 */
  readTerrainPatches() {
    if (!this.terrainPatches) return [];
    return this.terrainPatches.entries();
  }

  /** 按 tick 重放客户端实际执行过的 60Hz 输入步；协议不接受客户端 dt。 */
  /**
   * 记录一名玩家自己上报的鼠标拖拽形变。服务端不模拟它，只净化数值、判断是不是
   * 新的一次抓取，然后随快照转发；权威坐标、碰撞与玩法都不受影响。被外力捏着的
   * 时候这份让位——一块外壳只有一个形变来源。
   */
  applySlimeDrag(playerId, drag) {
    const deformation = this.players.get(playerId)?.getComponent(
      SOFT_BODY_DEFORMATION_COMPONENT,
    );
    if (!deformation) return;
    const sanitized = sanitizeSlimeDragState(drag);
    if (!sanitized) {
      deformation.release(null);
      return;
    }
    const regrab = isSlimeDragRegrab(
      deformation.heldExternally || !deformation.active ? undefined : deformation,
      sanitized,
    );
    deformation.applySelfReported(sanitized, this.now(), regrab);
  }

  /**
   * 被外力拴住时的缰绳。它必须过网：客户端预测跑的是同一份 stepCharacter，
   * 只在服务端加力，客户端就会一路走出去再被快照拽回来，变成持续的橡皮筋。
   */
  activeLeash(player) {
    const deformation = player.getComponent(SOFT_BODY_DEFORMATION_COMPONENT);
    // 几张嘴咬着就有几根绳，共享固定步只吃一根：取绷得最紧的那根，松的绳不出力。
    const holder = deformation?.tautestHold();
    if (!holder) return undefined;
    return {
      anchorX: roundCoordinate(holder.anchorX),
      anchorZ: roundCoordinate(holder.anchorZ),
      slack: holder.grabDistance + holder.leashSlack,
      stiffness: holder.leashStiffness,
      damping: holder.leashDamping,
      carry: holder.leashCarry,
      anchorVelocityX: roundCoordinate(holder.anchorVelocityX),
      anchorVelocityZ: roundCoordinate(holder.anchorVelocityZ),
    };
  }

  /** 这一帧要下发的形变；自己上报的那一份还要过超时。 */
  activeSlimeDrag(player) {
    const deformation = player.getComponent(SOFT_BODY_DEFORMATION_COMPONENT);
    if (!deformation) return undefined;
    deformation.expire(this.now());
    const state = deformation.snapshot();
    return state ? roundSlimeDrag(state) : undefined;
  }

  /**
   * 咬住 / 松口。一个不弹提示的彩蛋交互：交互键在没有别的候选可按时才走到这里，
   * 由服务端自己按权威位姿挑面前最近的人，客户端不指定目标，也就无从伪造。
   *
   * 它不改任何玩法状态——不掉血、不减速、也不移动被咬者——只让被咬那一处产生
   * 形变，所以整条下行复用已有的形变通道。咬住之后的推进归 SoftBodyBiteSystem。
   */
  toggleBite(playerId) {
    const player = this.players.get(playerId);
    const bite = player?.getComponent(BITE_COMPONENT);
    const pickupDrop = player?.getComponent(PICKUP_DROP_COMPONENT);
    if (!player || !bite || !pickupDrop) return false;
    if (bite.targetActorId) {
      this.#releaseBite(player, bite);
      return true;
    }
    const mouth = mouthWorld(player, pickupDrop);
    const radius = this.playerActorArchetype.components.render.radius;
    let target;
    let targetDeformation;
    let nearestDistance = bite.range;
    for (const candidate of this.players.values()) {
      if (candidate.id === playerId) continue;
      const deformation = candidate.getComponent(SOFT_BODY_DEFORMATION_COMPONENT);
      // 可以几张嘴一起咬同一个人——每多一张就多一个尖。满了或者自己已经咬着的跳过。
      if (
        !deformation
        || deformation.isHeldBy(playerId)
        || deformation.holderCount >= MAX_SOFT_BODY_HOLDERS
      ) continue;
      const distance = Math.hypot(
        candidate.x - mouth.x,
        candidate.y + radius * 0.5 - mouth.y,
        candidate.z - mouth.z,
      );
      if (distance >= nearestDistance) continue;
      // 得大致朝着对方：从背后隔着一点距离咬不到。
      const toTargetX = candidate.x - player.x;
      const toTargetZ = candidate.z - player.z;
      const planar = Math.hypot(toTargetX, toTargetZ);
      if (planar > 1e-6) {
        const facing = (
          (toTargetX / planar) * Math.sin(player.yaw)
          + (toTargetZ / planar) * Math.cos(player.yaw)
        );
        if (facing < bite.facingDot) continue;
      }
      nearestDistance = distance;
      target = candidate;
      targetDeformation = deformation;
    }
    if (!target) return false;

    if (!targetDeformation.grab(player.id, {
      // 缰绳从咬住那一刻的距离起算：咬上的瞬间不会被拽一下。
      grabDistance: Math.hypot(target.x - player.x, target.y - player.y, target.z - player.z),
      leashSlack: bite.leashSlack,
      leashStiffness: bite.leashStiffness,
      leashDamping: bite.leashDamping,
      leashCarry: bite.leashCarry,
    })) return false;
    if (!bite.bite(target.id)) {
      targetDeformation.release(player.id);
      return false;
    }
    // 立刻兑现一次：锚点由 updateHold 写，不先跑一次的话，抓住到下一个 tick
    // 之间发出的快照会带着一条指向世界原点的缰绳。
    targetDeformation.updateHold(player.id, target, player, player.characterState);
    return true;
  }

  #releaseBite(player, bite = player.getComponent(BITE_COMPONENT)) {
    const target = bite?.targetActorId ? this.players.get(bite.targetActorId) : undefined;
    target?.getComponent(SOFT_BODY_DEFORMATION_COMPONENT)?.release(player.id);
    bite?.release();
  }

  /** 玩家离开房间：他咬着的松开，咬着他的那张嘴也松开。 */
  #clearBitesOf(playerId) {
    const player = this.players.get(playerId);
    if (player) this.#releaseBite(player);
    for (const candidate of this.players.values()) {
      const bite = candidate.getComponent(BITE_COMPONENT);
      if (bite?.targetActorId === playerId) this.#releaseBite(candidate, bite);
    }
  }

  applyInput(playerId, message) {
    const player = this.players.get(playerId);
    const debugEnabled = this.playerTransformDebug?.isEnabled(playerId) === true;
    if (!player) {
      if (debugEnabled) this.emitPlayerTransformDebug(playerId, 'server.input_packet_ignored', {
        reason: 'player-not-found',
      });
      return;
    }
    if (debugEnabled) this.emitPlayerTransformDebug(playerId, 'server.input_packet_received', {
      inputCount: Array.isArray(message?.inputs) ? message.inputs.length : 0,
      firstTick: Array.isArray(message?.inputs) ? message.inputs[0]?.tick : undefined,
      lastTick: Array.isArray(message?.inputs) ? message.inputs.at(-1)?.tick : undefined,
      state: capturePlayerTransformDebugState(player),
    });
    if (!Array.isArray(message?.inputs) || message.inputs.length === 0) {
      if (debugEnabled) this.emitPlayerTransformDebug(playerId, 'server.input_packet_ignored', {
        reason: 'empty-inputs',
        state: capturePlayerTransformDebugState(player),
      });
      return;
    }
    const inputs = message.inputs
      .map((input) => ({ ...input, tick: Math.floor(toFiniteNumber(input?.tick, 0)) }))
      .filter((input) => input.tick > player.ackTick)
      .sort((left, right) => left.tick - right.tick)
      .slice(0, MAXIMUM_INPUT_STEPS_PER_PACKET);
    if (inputs.length === 0 || player.stepBudget < 1) {
      if (debugEnabled) this.emitPlayerTransformDebug(playerId, 'server.input_packet_ignored', {
        reason: inputs.length === 0 ? 'already-acknowledged' : 'step-budget-exhausted',
        state: capturePlayerTransformDebugState(player),
      });
      return;
    }

    // 玩家可能刚加入或刚跨过边界，先确认脚下这一片的静态碰撞体已经就位，
    // 否则这一步会从树里穿过去，再被下一个 tick 拉回来。
    this.chunkColliders.ensureAround(player.x, player.z);
    this.terrainColliders.ensureAround(player.x, player.z);
    this.generatedProps.ensureAround(player.x, player.z);
    this.actorWorld.context.refreshActorColliders?.();
    // 传送、出生修正或玩法系统可能直接更新 Transform；每包开始先把角色刚体
    // 对齐到同一份 characterState，避免视觉/服务端坐标走了而 Rapier 留在旧处。
    this.physics.setCharacterTranslation(player.id, player.characterState);
    let processed = 0;
    for (const input of inputs) {
      if (input.tick <= player.ackTick || player.stepBudget < 1) continue;
      const before = debugEnabled ? capturePlayerTransformDebugState(player) : undefined;
      const move = this.stepPlayerOnce(player, input);
      player.ackTick = input.tick;
      player.sequence = input.tick;
      processed += 1;
      if (debugEnabled) this.emitPlayerTransformDebug(playerId, 'server.input_step_applied', {
        input: {
          tick: input.tick,
          move,
          sprint: input.sprint === true,
          jump: input.jump === true,
          yaw: player.yaw,
        },
        before,
        after: capturePlayerTransformDebugState(player),
      });
    }
    if (processed > 0) {
      player.lastInputAt = this.now();
      // 真实输入回来了，之前替客户端补的空闲步余量作废，不能再叠加。
      this.idleSimulation.reset(player);
    }
    if (debugEnabled) this.emitPlayerTransformDebug(playerId, 'server.input_packet_completed', {
      processed,
      state: capturePlayerTransformDebugState(player),
    });
  }

  /**
   * 推进一名玩家的一个固定步。客户端上行的输入与服务端替它补的空闲步走的
   * 是同一条路径，权威状态只有这一个改动入口。调用方负责扣掉 ackTick 之类
   * 的协议字段；这里只消耗 stepBudget 并返回归一化后的移动输入。
   */
  stepPlayerOnce(player, input) {
    player.stepBudget -= 1;
    // 缰绳走共享固定步，权威与客户端预测因此算的是同一件事。
    player.characterParams.leash = this.activeLeash(player);
    player.yaw = normalizeAngle(toFiniteNumber(input.yaw, player.yaw));
    const move = sanitizeMoveInput({ ...input.move, sprint: input.sprint === true });
    player.syncWaterMovementEffect(this.isWaterAt(player.x, player.z));
    player.characterParams.walkSpeed = player.waterMovementEffect.moveSpeed;
    player.characterParams.buoyancyHeight = this.isWaterAt(player.x, player.z)
      ? this.playerBuoyancyHeightAt(
          player,
          player.x,
          player.z,
          toFiniteNumber(input.tick) * SIMULATION_STEP_SECONDS,
        )
      : undefined;
    stepCharacter(
      player.characterState,
      { move, sprint: input.sprint === true, jump: input.jump === true },
      SIMULATION_STEP_SECONDS,
      this.physics,
      player.characterParams,
    );
    player.setPosition(
      player.characterState.x,
      player.characterState.z,
      player.characterState.y,
    );
    player.jump.applyAuthoritativeState(
      player.characterState.vy,
      player.characterState.grounded,
    );
    player.syncWaterMovementEffect(this.isWaterAt(player.x, player.z));
    player.speed = Math.hypot(player.characterState.vx, player.characterState.vz);
    return move;
  }

  emitPlayerTransformDebug(playerId, event, data) {
    const serverTime = this.now();
    this.playerTransformDebug?.record({
      event,
      serverTime,
      serverTimeIso: new Date(serverTime).toISOString(),
      sceneTick: this.tick,
      playerId,
      data,
    });
  }

  /**
   * 天气是房间级权威离散状态。客户端只能提出一个合法枚举请求，不能上传
   * 粒子、风速、雾距离或其它表现参数；场景也可以完全关掉这条请求路径。
   */
  setWeather(playerId, weather) {
    if (!this.players.has(playerId)) return false;
    return this.environment.requestWeather(weather);
  }

  /** 房间当前天气；快照与测试都读这一个来源。 */
  get weather() {
    return this.environment.weather;
  }

  /**
   * 昼夜时刻同样是房间权威。客户端请求的是「跳到几点」，服务端决定接不接受；
   * 日轮角度、天空渐变和星空亮度全部由客户端本地按同步到的时刻推导。
   */
  setTimeOfDay(playerId, timeOfDay) {
    if (!this.players.has(playerId)) return false;
    return this.environment.requestTimeOfDay(timeOfDay);
  }

  isWaterAt(x, z) {
    if (this.fixedWaterWorld) return true;
    return this.terrainEnabled
      && sampleTerrain(this.worldSeed, x, z, {}, this.terrainCellCodeAt).surface
        === TERRAIN_SURFACE.WATER;
  }

  /** 出生定位使用的初始支撑高度；运行后的 Y 只由共享固定物理步推进。 */
  playerVerticalHeightAt(player, x, z, timeSeconds) {
    if (player.characterState?.grounded === false) return player.y;
    return this.playerSupportHeightAt(player, x, z, timeSeconds);
  }

  playerSupportHeightAt(player, x, z, timeSeconds) {
    const buoyancy = player.getComponent(BUOYANCY_COMPONENT);
    const water = Boolean(buoyancy) && this.isWaterAt(x, z);
    if (this.terrainEnabled) {
      const terrain = sampleTerrain(this.worldSeed, x, z, {}, this.terrainCellCodeAt);
      const support = terrainMovementHeight(
        terrain,
        this.actorWorld.context.seaLevel,
        buoyancy?.draft,
      );
      if (!water || !buoyancy) return support;
      return Math.max(terrain.groundY, support);
    }
    if (!water || !buoyancy) return 0;
    return this.actorWorld.context.seaLevel - buoyancy.draft;
  }

  playerBuoyancyHeightAt(player, x, z, timeSeconds) {
    const buoyancy = player.getComponent(BUOYANCY_COMPONENT);
    const supportY = this.playerSupportHeightAt(player, x, z, timeSeconds);
    if (!buoyancy || !this.isWaterAt(x, z)) return supportY;
    const targetY = supportY + sampleBuoyancyBobOffset(
      player.id,
      timeSeconds,
      buoyancy.bobAmplitude,
      buoyancy.bobFrequency,
    );
    if (!this.terrainEnabled) return targetY;
    const terrain = sampleTerrain(this.worldSeed, x, z, {}, this.terrainCellCodeAt);
    return Math.max(terrain.groundY, targetY);
  }

  /** 按服务端时钟补充固定模拟步预算。 */
  update() {
    this.tick += 1;
    const now = this.now();
    const elapsedSeconds = Math.max(0, (now - this.lastRefillAt) / 1000);
    this.lastRefillAt = now;
    this.environment.advance(elapsedSeconds);

    for (const player of this.players.values()) {
      player.stepBudget = Math.min(
        Math.floor(INPUT_TIME_BUDGET_SECONDS / SIMULATION_STEP_SECONDS),
        // 补充速率略高于客户端产出速率，卡顿后的积压才排得干净。
        player.stepBudget
          + (elapsedSeconds / SIMULATION_STEP_SECONDS) * INPUT_STEP_BUDGET_CATCH_UP_RATE,
      );
      if (now - player.lastInputAt > MOVEMENT_IDLE_TIMEOUT_MS) player.speed = 0;
    }
    // Actor 的碰撞盒由 ActorColliderIndex 在 tick 内同步，这里不用再管。
    this.actorWorld.update(elapsedSeconds, now / 1000);
    // 常驻的静态碰撞与生成物件都跟着玩家走；没人跨过 chunk 边界时直接返回。
    this.chunkColliders.sync(this.players.values());
    this.terrainColliders.sync(this.players.values());
    this.generatedProps.sync(this.players.values());
    // 走远的人自动退出容器界面；不依赖客户端自觉发关闭。
    this.updateContainerViewers();
    // 输入包是权威模拟的主驱动，但它可能整段消失。补步只覆盖「静默超时且仍在
    // 运动」的玩家，站着不动的一步都不跑，成本上界是房间人数而非世界面积。
    this.idleSimulation.advance(this.players.values(), elapsedSeconds, now);
    // Rapier refreshes its query pipeline during step; newly streamed trimeshes
    // are intentionally not query-visible before this point.
    this.physics.step();
    // Rapier 动态 Actor 在物理步之后立刻回写权威 Transform，当前快照即可看到弹出。
    this.actorWorld.context.syncDetachedPhysics?.();
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

  /**
   * 生成物件的掉落出生方式由原型配置。石头等默认在中心掉一堆；普通树把圆木
   * 从树中心拆开抛出；果树则从客户端画果实时使用的同一批枝头锚点开始下落。
   */
  spawnGeneratedPropDrop(prop, sourceTransform) {
    if (prop.dropSpawnPattern === 'center-scatter') {
      // 数量先拆成独立 Actor，使每根圆木都有自己的重力、碰撞、滚动和休眠状态。
      // 出生点刻意保持为树的同一个中心；只用初速度和朝向让它们随后自然散开。
      const actorCount = Math.max(1, Math.min(prop.dropQuantity, 12));
      const baseQuantity = Math.floor(prop.dropQuantity / actorCount);
      let remainder = prop.dropQuantity % actorCount;
      // createTreeModel 的可见高度约 3.98m，1.95m 是树体的几何中心而不是树根。
      const originY = (Number(sourceTransform.y) || 0) + prop.scale * 1.95;
      return Array.from({ length: actorCount }, (_, index) => {
        const angle = sourceTransform.yaw + ((index + 0.5) / actorCount) * Math.PI * 2;
        const horizontalSpeed = 0.72 + (index % 3) * 0.08;
        const quantity = baseQuantity + (remainder-- > 0 ? 1 : 0);
        return this.spawnItemStack(prop.dropArchetypeId, {
          position: [sourceTransform.x, originY, sourceTransform.z],
          quantity,
          velocity: [
            Math.cos(angle) * horizontalSpeed,
            0.96 + (index % 2) * 0.14,
            Math.sin(angle) * horizontalSpeed,
          ],
          // 圆木的长轴与预期滚动轴对齐；客户端再按权威位移累计滚动四元数。
          yaw: Math.PI / 2 - angle,
        });
      });
    }

    if (prop.dropSpawnPattern !== 'fruit-anchors') {
      return [this.spawnItemStack(prop.dropArchetypeId, {
        position: [
          sourceTransform.x,
          sourceTransform.y + Math.max(0.5, prop.scale * 0.55),
          sourceTransform.z,
        ],
        quantity: prop.dropQuantity,
        velocity: [0, 2.2, 0],
        yaw: sourceTransform.yaw,
      })];
    }

    const anchors = selectFruitDropAnchors(prop.dropQuantity);
    if (anchors.length === 0) return [];
    const baseQuantity = Math.floor(prop.dropQuantity / anchors.length);
    let remainder = prop.dropQuantity % anchors.length;
    return anchors.map((anchor, index) => {
      const origin = fruitDropWorldPosition(sourceTransform, prop.scale, anchor);
      // 很小的向外速度让果实落地后自然散开，纵向只给轻微松脱速度，主体仍是重力坠落。
      const horizontalSpeed = 0.62 + index * 0.08;
      const quantity = baseQuantity + (remainder-- > 0 ? 1 : 0);
      return this.spawnItemStack(prop.dropArchetypeId, {
        position: [origin.x, origin.y, origin.z],
        quantity,
        velocity: [
          Math.cos(origin.angle) * horizontalSpeed,
          0.18 + (index % 2) * 0.06,
          Math.sin(origin.angle) * horizontalSpeed,
        ],
        yaw: origin.angle,
      });
    });
  }

  createSnapshot(viewerPlayerId) {
    const viewer = viewerPlayerId ? this.players.get(viewerPlayerId) : undefined;
    return {
      sceneId: this.id,
      tick: this.tick,
      serverTime: this.now(),
      ...this.environment.snapshot(),
      actors: createActorSnapshots(this.actorWorld, { viewer }),
      players: Array.from(this.players.values(), (player) => {
        const slimeDrag = this.activeSlimeDrag(player);
        const bitingPlayerId = player.getComponent(BITE_COMPONENT)?.targetActorId;
        const leash = this.activeLeash(player);
        return {
          id: player.id,
          name: player.name,
          x: roundCoordinate(player.x),
          y: roundCoordinate(player.y),
          z: roundCoordinate(player.z),
          yaw: roundCoordinate(player.yaw),
          speed: roundCoordinate(player.speed),
          ackTick: player.ackTick,
          sequence: player.ackTick,
          verticalVelocity: roundCoordinate(player.characterState.vy),
          velocityX: roundCoordinate(player.characterState.vx),
          velocityZ: roundCoordinate(player.characterState.vz),
          grounded: player.characterState.grounded,
          // 背包只发给本人：别人包里有什么不是这名玩家该知道的，一屋子人也不该
          // 每帧互相推送全部库存。嘴上叼着什么是看得见的，照发。
          ...(player.id === viewerPlayerId ? {
            inventory: player.requireComponent(INVENTORY_COMPONENT).snapshot(),
            inventoryRevision: player.requireComponent(INVENTORY_COMPONENT).revision,
            hotbar: player.requireComponent(INVENTORY_COMPONENT).hotbarSnapshot(),
          } : {}),
          heldActorId: player.getComponent(PICKUP_DROP_COMPONENT)?.heldActorId ?? null,
          pickupDropRevision: player.getComponent(PICKUP_DROP_COMPONENT)?.revision ?? 0,
          ...(slimeDrag ? { slimeDrag } : {}),
          ...(bitingPlayerId ? { bitingPlayerId } : {}),
          ...(leash ? { leash } : {}),
        };
      }),
    };
  }
}
