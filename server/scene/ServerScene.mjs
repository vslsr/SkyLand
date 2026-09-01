import {
  DEFAULT_PLAYER_MOVEMENT,
  PLAYER_BOUNDS,
  PLAYER_COLLISION_RADIUS,
  clampToPlayArea,
  createSpawnPoint,
  normalizeAngle,
  sanitizeMoveInput,
  toFiniteNumber,
} from '../../shared/playerMovement.mjs';
import {
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
  ELASTIC_TETHER_COMPONENT,
  GENERATED_PROP_COMPONENT,
  INTERACTABLE_COMPONENT,
  INVENTORY_COMPONENT,
  ITEM_STACK_COMPONENT,
  sampleBuoyancyBobOffset,
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
import { ServerTerrainColliders } from './ServerTerrainColliders.mjs';
import { PhysicsWorld, getRapier } from '../../shared/physics/index.mjs';
import { stepCharacter } from '../../shared/physics/stepCharacter.mjs';
import { parseGeneratedPropId } from '../../shared/world/generatedProp.mjs';
import {
  fruitDropWorldPosition,
  selectFruitDropAnchors,
} from '../../shared/world/fruitDrop.mjs';
import { toWorldSeed } from '../../shared/world/worldConfig.mjs';
import { DEFAULT_WEATHER, isWeatherType } from '../../shared/weather.mjs';
import { TERRAIN_CELL_SIZE, TERRAIN_SURFACE } from '../../shared/world/terrainConfig.mjs';
import { sampleTerrain } from '../../shared/world/terrainContent.mjs';
import { TerrainEditor } from '../../shared/world/terrainEditing.mjs';
import { TerrainPatchStore } from '../../shared/world/terrainPatches.mjs';
import { terrainMovementHeight } from '../../shared/world/terrainMovement.mjs';

function roundCoordinate(value) {
  return Math.round(value * 1000) / 1000;
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
  const renderModel = archetype?.components.render.model;
  if (
    !archetype?.components.playerMovement
    || (renderModel !== 'line-art-player-slime' && renderModel !== 'line-art-pbf-slime')
  ) {
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
    this.weather = DEFAULT_WEATHER;
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
    const spawnGroundY = this.terrainEnabled
      ? terrainMovementHeight(
          sampleTerrain(this.worldSeed, spawn.x, spawn.z, {}, this.terrainCellCodeAt),
          this.actorWorld.context.seaLevel,
          buoyancy?.draft,
        )
      : 0;
    const collisionPlaced = this.collision.resolveCircle(spawn, radius, {
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
      // 可再生的在冷却里会被 harvest 拒掉，不需要在这里单独判一次。
      if (!prop.harvest(this.now() / 1000)) return false;
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
      case 'water': return this.terrainEditor.setSurface(cellX, cellZ, TERRAIN_SURFACE.WATER);
      case 'ground': return this.terrainEditor.setSurface(cellX, cellZ, TERRAIN_SURFACE.GROUND);
      case 'reset': return this.terrainEditor.reset(cellX, cellZ);
      default: return false;
    }
  }

  /** 房间新成员加入时用来补齐已有编辑。 */
  readTerrainPatches() {
    if (!this.terrainPatches) return [];
    return this.terrainPatches.entries();
  }

  /** 按 tick 重放客户端实际执行过的 60Hz 输入步；协议不接受客户端 dt。 */
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
    // 传送、出生修正或玩法系统可能直接更新 Transform；每包开始先把角色刚体
    // 对齐到同一份 characterState，避免视觉/服务端坐标走了而 Rapier 留在旧处。
    this.physics.setCharacterTranslation(player.id, player.characterState);
    let processed = 0;
    for (const input of inputs) {
      if (input.tick <= player.ackTick || player.stepBudget < 1) continue;
      const before = debugEnabled ? capturePlayerTransformDebugState(player) : undefined;
      player.stepBudget -= 1;
      player.yaw = normalizeAngle(toFiniteNumber(input.yaw, player.yaw));
      const move = sanitizeMoveInput({ ...input.move, sprint: input.sprint === true });
      player.syncWaterMovementEffect(
        player.characterState.grounded && this.isWaterAt(player.x, player.z),
      );
      player.characterParams.walkSpeed = player.waterMovementEffect.moveSpeed;
      player.characterParams.buoyancyHeight = this.isWaterAt(player.x, player.z)
        ? this.playerSupportHeightAt(player, player.x, player.z, this.now() / 1000)
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
      player.syncWaterMovementEffect(
        player.characterState.grounded && this.isWaterAt(player.x, player.z),
      );
      player.speed = Math.hypot(player.characterState.vx, player.characterState.vz);
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
    if (processed > 0) player.lastInputAt = this.now();
    if (debugEnabled) this.emitPlayerTransformDebug(playerId, 'server.input_packet_completed', {
      processed,
      state: capturePlayerTransformDebugState(player),
    });
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
   * 粒子、风速、雾距离或其它表现参数。
   */
  setWeather(playerId, weather) {
    if (!this.players.has(playerId) || !isWeatherType(weather)) return false;
    this.weather = weather;
    return true;
  }

  isWaterAt(x, z) {
    if (this.fixedWaterWorld) return true;
    return this.terrainEnabled
      && sampleTerrain(this.worldSeed, x, z, {}, this.terrainCellCodeAt).surface
        === TERRAIN_SURFACE.WATER;
  }

  /**
   * 玩家权威 Y：地面/海床支撑先由共享地形决定，水中再叠加有界解析浮动。
   * 每名玩家每 tick 只采样一次，成本与在线玩家数成正比，不扫描水面或 chunk。
   */
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
      return Math.max(
        terrain.groundY,
        support + sampleBuoyancyBobOffset(
          player.id,
          timeSeconds,
          buoyancy.bobAmplitude,
          buoyancy.bobFrequency,
        ),
      );
    }
    if (!water || !buoyancy) return 0;
    return this.actorWorld.context.seaLevel
      - buoyancy.draft
      + sampleBuoyancyBobOffset(
        player.id,
        timeSeconds,
        buoyancy.bobAmplitude,
        buoyancy.bobFrequency,
      );
  }

  playerBuoyancyOffsetAt(player, timeSeconds) {
    const buoyancy = player.getComponent(BUOYANCY_COMPONENT);
    return buoyancy && this.isWaterAt(player.x, player.z)
      ? sampleBuoyancyBobOffset(
          player.id,
          timeSeconds,
          buoyancy.bobAmplitude,
          buoyancy.bobFrequency,
        )
      : 0;
  }

  /** 按服务端时钟补充固定模拟步预算。 */
  update() {
    this.tick += 1;
    const now = this.now();
    const elapsedSeconds = Math.max(0, (now - this.lastRefillAt) / 1000);
    this.lastRefillAt = now;

    for (const player of this.players.values()) {
      player.stepBudget = Math.min(
        Math.floor(INPUT_TIME_BUDGET_SECONDS / SIMULATION_STEP_SECONDS),
        player.stepBudget + elapsedSeconds / SIMULATION_STEP_SECONDS,
      );
      if (now - player.lastInputAt > MOVEMENT_IDLE_TIMEOUT_MS) player.speed = 0;
      if (
        player.characterState.grounded
        && this.isWaterAt(player.x, player.z)
        && player.getComponent(BUOYANCY_COMPONENT)
      ) {
        const supportY = this.playerSupportHeightAt(player, player.x, player.z, now / 1000);
        player.setPosition(player.x, player.z, supportY);
        player.characterState.vy = 0;
        this.physics.setCharacterTranslation(player.id, player.characterState);
      }
    }
    // Actor 的碰撞盒由 ActorColliderIndex 在 tick 内同步，这里不用再管。
    this.actorWorld.update(elapsedSeconds, now / 1000);
    // 常驻的静态碰撞与生成物件都跟着玩家走；没人跨过 chunk 边界时直接返回。
    this.chunkColliders.sync(this.players.values());
    this.terrainColliders.sync(this.players.values());
    this.generatedProps.sync(this.players.values());
    // Rapier refreshes its query pipeline during step; newly streamed trimeshes
    // are intentionally not query-visible before this point.
    this.physics.step();
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
      weather: this.weather,
      actors: createActorSnapshots(this.actorWorld, { viewer }),
      players: Array.from(this.players.values(), (player) => ({
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
        inventory: player.requireComponent(INVENTORY_COMPONENT).snapshot(),
        inventoryRevision: player.requireComponent(INVENTORY_COMPONENT).revision,
      })),
    };
  }
}
