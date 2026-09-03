import { sanitizeMoveInput, toFiniteNumber } from '../playerMovement.mjs';
import {
  BUOYANCY_DAMPING,
  BUOYANCY_SPRING_STIFFNESS,
  BUOYANCY_SUPPORT_DISTANCE,
  BUOYANCY_SUPPORT_SPEED,
  GROUND_SNAP_PROBE,
} from './characterParams.mjs';

const EPSILON = 1e-6;

/** 拖带在绳长之外这么长一段里渐入，免得刚好压在边界上时一帧带一帧不带地抖。 */
const LEASH_CARRY_RAMP = 0.3;

function moveVectorTowards(currentX, currentZ, targetX, targetZ, maximumDelta) {
  const deltaX = targetX - currentX;
  const deltaZ = targetZ - currentZ;
  const distance = Math.hypot(deltaX, deltaZ);
  if (distance <= maximumDelta || distance <= EPSILON) return { x: targetX, z: targetZ };
  const amount = maximumDelta / distance;
  return { x: currentX + deltaX * amount, z: currentZ + deltaZ * amount };
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

/** The only player simulation step used by browser prediction and room authority. */
export function stepCharacter(state, input, deltaSeconds, physics, params) {
  const dt = Math.max(0, toFiniteNumber(deltaSeconds));
  if (dt <= 0) return state;
  const move = sanitizeMoveInput({ ...input?.move, sprint: input?.sprint === true });
  const buoyancyHeight = Number(params.buoyancyHeight);
  const buoyant = Number.isFinite(buoyancyHeight);
  physics.setCharacterSnapToGround?.(params.characterId, !buoyant);
  const inputLength = Math.hypot(move.x, move.z);
  const walkSpeed = Math.max(0, toFiniteNumber(params.walkSpeed));
  const speed = walkSpeed * (move.sprint ? Math.max(1, toFiniteNumber(params.sprintMultiplier, 1)) : 1);
  const targetVx = inputLength > EPSILON ? move.x / inputLength * speed : 0;
  const targetVz = inputLength > EPSILON ? move.z / inputLength * speed : 0;
  const acceleration = state.grounded
    ? (inputLength > EPSILON ? params.acceleration : params.deceleration)
    : params.airAcceleration * params.airControl;
  const horizontal = moveVectorTowards(
    state.vx,
    state.vz,
    targetVx,
    targetVz,
    Math.max(0, toFiniteNumber(acceleration)) * dt,
  );
  state.vx = horizontal.x;
  state.vz = horizontal.z;

  // 被咬住/钩住时的缰绳。绳长以内完全自由，出了绳长每多走一米就多拽回一分，
  // 所以是「越走越拉不动」而不是撞上一堵看不见的墙：玩家自己的驱动加速度有上限，
  // 拉力没有，两者相等的地方就是他能挣到的最远处。
  //
  // 它必须写在这一步共享的固定步里：只在服务端加力，客户端预测就会一路走出去
  // 再被快照拽回来，变成持续的橡皮筋。只作用于水平面——竖直方向留给重力与跳跃。
  const leash = params.leash;
  if (leash) {
    const deltaX = state.x - leash.anchorX;
    const deltaZ = state.z - leash.anchorZ;
    const distance = Math.hypot(deltaX, deltaZ);
    const overshoot = distance - Math.max(0, toFiniteNumber(leash.slack));
    if (overshoot > 0 && distance > EPSILON) {
      const directionX = deltaX / distance;
      const directionZ = deltaZ / distance;
      // 纯弹簧会形成极限环：玩家被弹回去、绳松了又冲出来，在绳长附近来回荡。
      // 阻尼项按径向速度取，往外冲时加大拉力，往回收时减小，于是停在绳边上
      // 而不是在它两侧反复穿越。夹在 0 以上：缰绳只会拽回来，不会把人推出去。
      const radialVelocity = state.vx * directionX + state.vz * directionZ;
      const pull = Math.max(0, (
        overshoot * Math.max(0, toFiniteNumber(leash.stiffness))
        + radialVelocity * Math.max(0, toFiniteNumber(leash.damping))
      )) * dt;
      state.vx -= directionX * pull;
      state.vz -= directionZ * pull;

      // 绳绷紧之后，拖的人说了算：直接把被拖者的速度往锚点速度上带，而不是再加
      // 一份和他自己驱动力较劲的拉力。被拖者的驱动是有上限的加速度，这一项不是，
      // 所以挣扎只能改变被拖出去的姿势，改变不了被拖走这件事。
      //
      // 拿速度而不是加速度，是因为「拖着走」的自然结果是两者速度相同；用加速度
      // 较劲会稳定在一个被挣扎撑开的间距上，绳子越拉越长。
      const carry = Math.max(0, toFiniteNumber(leash.carry));
      if (carry > 0) {
        // 在绳长附近渐入，避免刚好压在边界上时一帧带一帧不带地抖。
        const tautness = Math.min(1, overshoot / LEASH_CARRY_RAMP);
        const follow = (1 - Math.exp(-carry * dt)) * tautness;
        state.vx += (toFiniteNumber(leash.anchorVelocityX) - state.vx) * follow;
        state.vz += (toFiniteNumber(leash.anchorVelocityZ) - state.vz) * follow;
      }
    }
  }

  const jumpPressed = input?.jump === true;
  const buoyancyJumpSupported = buoyant
    && state.y <= buoyancyHeight + BUOYANCY_SUPPORT_DISTANCE;
  const jumpStarted = jumpPressed
    && !state.jumpPressed
    && (state.grounded || buoyancyJumpSupported);
  state.jumpPressed = jumpPressed;
  if (jumpStarted) {
    state.vy = Math.max(0, toFiniteNumber(params.jumpImpulse));
    state.grounded = false;
  } else if (buoyant && state.y <= buoyancyHeight) {
    // 水面不是瞬移平面。浸入目标吃水线后用弹簧/阻尼改变垂直速度，位置仍由
    // KCC 位移和 Rapier 碰撞结果推进；从岸上进入水域时先按重力自然下落。
    const buoyancyAcceleration = (buoyancyHeight - state.y) * BUOYANCY_SPRING_STIFFNESS
      - state.vy * BUOYANCY_DAMPING;
    state.vy = clamp(
      state.vy + buoyancyAcceleration * dt,
      -Math.max(0, toFiniteNumber(params.maximumFallSpeed)),
      Math.max(0, toFiniteNumber(params.jumpImpulse)),
    );
  } else if (state.grounded) {
    state.vy = -GROUND_SNAP_PROBE;
  } else {
    state.vy = Math.max(
      -Math.max(0, toFiniteNumber(params.maximumFallSpeed)),
      state.vy - Math.max(0, toFiniteNumber(params.gravity)) * dt,
    );
  }

  const desired = { x: state.vx * dt, y: state.vy * dt, z: state.vz * dt };
  if (params.bounds) {
    desired.x = clamp(state.x + desired.x, params.bounds.minimumX, params.bounds.maximumX) - state.x;
    desired.z = clamp(state.z + desired.z, params.bounds.minimumZ, params.bounds.maximumZ) - state.z;
  }
  physics.prepareQueries();
  const result = physics.computeCharacterMovement(params.characterId, desired);

  // Project velocity out of obstacle normals while preserving tangent inertia.
  for (const collision of result.collisions) {
    const normal = collision.normal;
    if (Math.abs(normal.y) < 0.7) {
      const intoWall = state.vx * normal.x + state.vz * normal.z;
      if (intoWall < 0) {
        state.vx -= normal.x * intoWall;
        state.vz -= normal.z * intoWall;
      }
    } else if (normal.y < -0.7 && state.vy > 0) {
      state.vy = 0;
    }
  }

  physics.step(dt);
  const position = physics.getCharacterTranslation(params.characterId);
  state.x = position.x;
  state.z = position.z;
  state.y = position.y;
  const buoyancySupported = buoyant
    && Math.abs(state.y - buoyancyHeight) <= BUOYANCY_SUPPORT_DISTANCE
    && Math.abs(state.vy) <= BUOYANCY_SUPPORT_SPEED;
  state.grounded = state.vy > 0 ? false : (result.grounded || buoyancySupported);
  if (state.grounded && state.vy < 0) state.vy = 0;
  return state;
}

export function createCharacterSimulationParams(characterId, movement, jump, options = {}) {
  return {
    characterId,
    walkSpeed: Math.max(0, toFiniteNumber(movement?.walkSpeed)),
    sprintMultiplier: Math.max(1, toFiniteNumber(movement?.sprintMultiplier, 1)),
    acceleration: Math.max(0.01, toFiniteNumber(movement?.acceleration, 28)),
    deceleration: Math.max(0.01, toFiniteNumber(movement?.deceleration, 24)),
    airAcceleration: Math.max(0, toFiniteNumber(movement?.airAcceleration, 8)),
    airControl: clamp(toFiniteNumber(jump?.airControl, 0.85), 0, 1),
    jumpImpulse: Math.max(0, toFiniteNumber(jump?.impulse, 7)),
    gravity: Math.max(0, toFiniteNumber(jump?.gravity, 22)),
    maximumFallSpeed: Math.max(0, toFiniteNumber(jump?.maximumFallSpeed, 20)),
    buoyancyHeight: /** @type {number | undefined} */ (undefined),
    /**
     * 被外力拴住时的缰绳；自由时是 undefined。
     * {anchorX, anchorZ, slack, stiffness, damping, carry, anchorVelocityX, anchorVelocityZ}
     */
    leash: /** @type {object | undefined} */ (undefined),
    bounds: options.bounds,
  };
}
