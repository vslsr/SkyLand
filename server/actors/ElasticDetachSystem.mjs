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
        if (length >= tether.detachLength) {
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
            this.createBody(world.context.physics, actor.id, motion, transform);
            world.context.physics.applyDynamicActorImpulse(actor.id, popped.impulse);
            world.context.physics.applyDynamicActorTorqueImpulse(actor.id, popped.torqueImpulse);
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
        this.createBody(physics, actor.id, motion, transform);
        physics.setDynamicActorVelocity(actor.id, {
          x: motion.velocityX, y: motion.velocityY, z: motion.velocityZ,
        });
      }
      physics.applyDynamicActorGravity(actor.id, motion.gravity, delta);
      this.syncActor(physics, actor, motion, transform);
    }
  }

  syncTransforms(world) {
    const physics = world.context.physics;
    if (!physics) return;
    for (const actor of world.query(
      ELASTIC_DETACH_COMPONENT,
      DROP_MOTION_COMPONENT,
      TRANSFORM_COMPONENT,
    )) {
      if (!actor.requireComponent(ELASTIC_DETACH_COMPONENT).detached) continue;
      this.syncActor(
        physics,
        actor,
        actor.requireComponent(DROP_MOTION_COMPONENT),
        actor.requireComponent(TRANSFORM_COMPONENT),
      );
    }
  }

  createBody(physics, actorId, motion, transform) {
    physics.createDynamicActor(actorId, {
      x: transform.x,
      y: transform.y + motion.radius,
      z: transform.z,
      radius: motion.radius,
      linearDamping: motion.drag,
      angularDamping: motion.angularDamping,
      restitution: motion.restitution,
      friction: motion.groundDrag,
      // chunk 卸载后重建时，物件已经躺在地上了，朝向必须跟着回来。
      rotation: {
        x: motion.rotationX, y: motion.rotationY, z: motion.rotationZ, w: motion.rotationW,
      },
    });
  }

  syncActor(physics, actor, motion, transform) {
    const state = physics.getDynamicActorState(actor.id);
    if (!state) return;
    motion.velocityX = state.velocity.x;
    motion.velocityY = state.velocity.y;
    motion.velocityZ = state.velocity.z;
    // 朝向和位置一样是权威结果；yaw 留给未脱离时的摆放，脱落后由四元数接管。
    motion.setRotation(state.rotation);
    transform.setWorldTransform([
      state.position.x,
      state.position.y - motion.radius,
      state.position.z,
    ], transform.yaw);
  }
}
