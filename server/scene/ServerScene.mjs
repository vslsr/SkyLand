import {
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
  INTERACTABLE_COMPONENT,
  SIMPLE_COLLISION_COMPONENT,
  TRANSFORM_COMPONENT,
  VESSEL_MOTOR_COMPONENT,
} from '../../shared/actor/index.mjs';
import { resolveCircleAgainstSimpleCollisions } from '../../shared/actor/simpleCollision.mjs';
import {
  createActorSnapshots,
  createServerActorWorld,
} from '../actors/ServerActorFactory.mjs';
import {
  addVesselCargo,
  damageVesselPart,
  removeVesselCargo,
} from '../actors/VesselStateMutations.mjs';

function roundCoordinate(value) {
  return Math.round(value * 1000) / 1000;
}

const ACTOR_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function sanitizeActorId(value) {
  const id = String(value ?? '').slice(0, 48);
  return ACTOR_ID_PATTERN.test(id) ? id : undefined;
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
    this.actorWorld = createServerActorWorld(definition);
    this.tick = 0;
    this.players = new Map();
    this.now = options.now ?? (() => Date.now());
    this.lastRefillAt = this.now();
  }

  addPlayer(player) {
    const spawn = createSpawnPoint(player.slot ?? this.players.size, this.spawn, this.bounds);
    this.players.set(player.id, {
      id: player.id,
      name: player.name,
      x: spawn.x,
      z: spawn.z,
      yaw: Math.PI,
      speed: 0,
      sequence: 0,
      actorInteractionSequence: 0,
      timeBudget: INPUT_TIME_BUDGET_SECONDS,
      lastInputAt: this.now(),
    });
  }

  removePlayer(playerId) {
    this.players.delete(playerId);
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

  /**
   * 场景交互入口。自由镜头不属于权威玩法坐标，因此距离以玩家控制的木筏为基准。
   * 当前 cargo-toggle 同时完成装载/卸载、附着状态和浮力载荷变更。
   */
  interactWithActor(playerId, message) {
    const player = this.players.get(playerId);
    if (!player) return false;
    const sequence = Math.floor(toFiniteNumber(message?.sequence, 0));
    if (sequence <= player.actorInteractionSequence) return false;
    const target = this.actorWorld.getActor(sanitizeActorId(message?.actorId));
    const interactable = target?.getComponent(INTERACTABLE_COMPONENT);
    const cargo = target?.getComponent(CARGO_COMPONENT);
    const targetTransform = target?.getComponent(TRANSFORM_COMPONENT);
    if (!target || !interactable?.enabled || !cargo || !targetTransform) return false;
    if (interactable.action !== 'cargo-toggle') return false;

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
    const next = applyPlayerMovement({ x: player.x, z: player.z }, move, granted, this.bounds);
    const colliders = this.actorWorld
      .query(TRANSFORM_COMPONENT, SIMPLE_COLLISION_COMPONENT)
      .map((actor) => ({
        collision: actor.requireComponent(SIMPLE_COLLISION_COMPONENT),
        transform: actor.requireComponent(TRANSFORM_COMPONENT),
      }));
    const resolved = clampToPlayArea(
      resolveCircleAgainstSimpleCollisions(next, PLAYER_COLLISION_RADIUS, colliders),
      this.bounds,
    );
    const distance = Math.hypot(resolved.x - player.x, resolved.z - player.z);
    player.x = resolved.x;
    player.z = resolved.z;
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
    this.actorWorld.update(elapsedSeconds, now / 1000);
  }

  createSnapshot() {
    return {
      sceneId: this.id,
      tick: this.tick,
      serverTime: this.now(),
      actors: createActorSnapshots(this.actorWorld),
      players: Array.from(this.players.values(), (player) => ({
        id: player.id,
        name: player.name,
        x: roundCoordinate(player.x),
        z: roundCoordinate(player.z),
        yaw: roundCoordinate(player.yaw),
        speed: roundCoordinate(player.speed),
        sequence: player.sequence,
      })),
    };
  }
}
