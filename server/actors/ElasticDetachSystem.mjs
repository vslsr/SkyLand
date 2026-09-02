import {
  DROP_MOTION_COMPONENT,
  ELASTIC_DETACH_COMPONENT,
  ELASTIC_TETHER_COMPONENT,
  INTERACTABLE_COMPONENT,
  SIMPLE_COLLISION_COMPONENT,
  TRANSFORM_COMPONENT,
} from '../../shared/actor/index.mjs';
import { releaseElasticTether } from './ElasticTetherMutations.mjs';

/** 服务端权威的“拔出并落地”运动；只遍历组合了 elasticDetach 的 Actor。 */
export class ElasticDetachSystem {
  update(world, deltaSeconds) {
    const delta = Math.max(0, Math.min(Number(deltaSeconds) || 0, 0.1));
    for (const actor of world.query(
      ELASTIC_DETACH_COMPONENT,
      ELASTIC_TETHER_COMPONENT,
      DROP_MOTION_COMPONENT,
      INTERACTABLE_COMPONENT,
      TRANSFORM_COMPONENT,
    )) {
      const detachable = actor.requireComponent(ELASTIC_DETACH_COMPONENT);
      const tether = actor.requireComponent(ELASTIC_TETHER_COMPONENT);
      const motion = actor.requireComponent(DROP_MOTION_COMPONENT);
      const interactable = actor.requireComponent(INTERACTABLE_COMPONENT);
      const transform = actor.requireComponent(TRANSFORM_COMPONENT);

      if (!detachable.detached && tether.holderPlayerId) {
        const dx = tether.targetX - transform.x;
        const dy = tether.targetY - transform.y;
        const dz = tether.targetZ - transform.z;
        const length = Math.hypot(dx, dy, dz);
        if (length >= tether.breakLength) {
          const inverseLength = length > 1e-6 ? 1 / length : 0;
          const direction = {
            x: dx * inverseLength,
            y: dy * inverseLength,
            z: dz * inverseLength,
          };
          const popped = detachable.pop(direction);
          releaseElasticTether(tether, interactable);
          // 脱离锚点后不再允许重复叼住；它已经成为自由物体。
          if (interactable.enabled) {
            interactable.enabled = false;
            interactable.revision += 1;
          }
          if (popped && world.context.physics) {
            world.context.physics.createDynamicActor(actor.id, {
              x: transform.x,
              y: transform.y + motion.radius,
              z: transform.z,
              radius: motion.radius,
              linearDamping: motion.drag,
              restitution: motion.restitution,
              friction: motion.groundDrag,
            });
            world.context.physics.applyDynamicActorImpulse(actor.id, popped.impulse);
          }
        }
      }
      if (!detachable.detached || delta === 0) continue;
      if (!detachable.dropCollisionApplied) {
        actor.requireComponent(SIMPLE_COLLISION_COMPONENT).setDefinition({
          shape: 'cylinder',
          halfWidth: motion.radius,
          halfLength: motion.radius,
          minimumY: -motion.radius,
          maximumY: motion.radius,
        });
        detachable.dropCollisionApplied = true;
      }
      const physics = world.context.physics;
      if (!physics) continue;
      if (!physics.hasDynamicActor(actor.id)) {
        physics.createDynamicActor(actor.id, {
          x: transform.x,
          y: transform.y + motion.radius,
          z: transform.z,
          radius: motion.radius,
          linearDamping: motion.drag,
          restitution: motion.restitution,
          friction: motion.groundDrag,
        });
        physics.setDynamicActorVelocity(actor.id, {
          x: motion.velocityX, y: motion.velocityY, z: motion.velocityZ,
        });
      }
      physics.applyDynamicActorGravity(actor.id, motion.gravity, delta);
      const state = physics.getDynamicActorState(actor.id);
      if (!state) continue;
      motion.velocityX = state.velocity.x;
      motion.velocityY = state.velocity.y;
      motion.velocityZ = state.velocity.z;
      transform.setWorldTransform([
        state.position.x,
        state.position.y - motion.radius,
        state.position.z,
      ], transform.yaw);
    }
  }
}
