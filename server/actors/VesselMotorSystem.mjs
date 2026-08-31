import {
  ACTOR_CONTROL_COMPONENT,
  BUOYANCY_COMPONENT,
  TRANSFORM_COMPONENT,
  VESSEL_MOTOR_COMPONENT,
} from '../../shared/actor/index.mjs';
import { normalizeAngle } from '../../shared/playerMovement.mjs';

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function approach(value, target, maximumDelta) {
  if (value < target) return Math.min(value + maximumDelta, target);
  if (value > target) return Math.max(value - maximumDelta, target);
  return target;
}

/** 服务端权威船舶推进；客户端只提交 throttle/steering。 */
export class VesselMotorSystem {
  update(world, deltaSeconds, elapsedSeconds) {
    const delta = clamp(Number(deltaSeconds) || 0, 0, 0.25);
    const nowMs = elapsedSeconds * 1000;
    for (const actor of world.query(
      TRANSFORM_COMPONENT,
      BUOYANCY_COMPONENT,
      ACTOR_CONTROL_COMPONENT,
      VESSEL_MOTOR_COMPONENT,
    )) {
      const transform = actor.requireComponent(TRANSFORM_COMPONENT);
      const buoyancy = actor.requireComponent(BUOYANCY_COMPONENT);
      const control = actor.requireComponent(ACTOR_CONTROL_COMPONENT);
      const motor = actor.requireComponent(VESSEL_MOTOR_COMPONENT);

      if (!control.ownerPlayerId || nowMs - control.lastInputAt > motor.inputTimeoutMs) {
        motor.stopInput();
      }
      if (delta <= 0) continue;

      const speedFactor = clamp(Number(buoyancy.speedFactor) || 0, 0, 1);
      const maximumSpeed = motor.throttle >= 0
        ? motor.maximumForwardSpeed
        : motor.maximumReverseSpeed;
      const targetSpeed = motor.throttle * maximumSpeed * speedFactor;
      let rate = motor.drag;
      if (Math.abs(motor.throttle) > 1e-4) {
        const sameDirection = Math.sign(targetSpeed) === Math.sign(motor.speed) || motor.speed === 0;
        rate = sameDirection && Math.abs(targetSpeed) > Math.abs(motor.speed)
          ? motor.acceleration
          : motor.deceleration;
      }
      motor.speed = approach(motor.speed, targetSpeed, rate * delta);
      if (speedFactor <= 0) motor.speed = approach(motor.speed, 0, motor.deceleration * delta);

      const speedRatio = clamp(Math.abs(motor.speed) / motor.maximumForwardSpeed, 0, 1);
      const turnAuthority = speedRatio > 0 ? 0.2 + speedRatio * 0.8 : 0;
      const direction = motor.speed < 0 ? -1 : 1;
      transform.yaw = normalizeAngle(
        transform.yaw + motor.steering * motor.turnSpeed * turnAuthority * direction * delta,
      );
      transform.x += Math.sin(transform.yaw) * motor.speed * delta;
      transform.z += Math.cos(transform.yaw) * motor.speed * delta;

      const bounds = world.context.bounds;
      if (bounds) {
        const clampedX = clamp(transform.x, bounds.minimumX, bounds.maximumX);
        const clampedZ = clamp(transform.z, bounds.minimumZ, bounds.maximumZ);
        if (clampedX !== transform.x || clampedZ !== transform.z) motor.speed = 0;
        transform.x = clampedX;
        transform.z = clampedZ;
      }
    }
  }
}
