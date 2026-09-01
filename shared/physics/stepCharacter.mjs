import { sanitizeMoveInput, toFiniteNumber } from '../playerMovement.mjs';
import { GROUND_SNAP_PROBE } from './characterParams.mjs';

const EPSILON = 1e-6;

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
  if (buoyant && state.grounded) {
    state.y = buoyancyHeight;
    state.vy = 0;
    physics.setCharacterTranslation(params.characterId, state);
  }
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

  const jumpPressed = input?.jump === true;
  const jumpStarted = jumpPressed && !state.jumpPressed && state.grounded;
  state.jumpPressed = jumpPressed;
  if (jumpStarted) {
    state.vy = Math.max(0, toFiniteNumber(params.jumpImpulse));
    state.grounded = false;
  } else if (state.grounded) {
    state.vy = buoyant ? 0 : -GROUND_SNAP_PROBE;
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
  if (buoyant && !jumpStarted && state.vy <= 0 && (state.grounded || position.y <= buoyancyHeight)) {
    state.y = buoyancyHeight;
    state.vy = 0;
    state.grounded = true;
    physics.setCharacterTranslation(params.characterId, state);
  } else {
    state.y = position.y;
    state.grounded = state.vy > 0 ? false : result.grounded;
  }
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
    bounds: options.bounds,
  };
}
