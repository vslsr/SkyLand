import {
  DROP_MOTION_COMPONENT,
  ELASTIC_DETACH_COMPONENT,
  ELASTIC_TETHER_COMPONENT,
  INTERACTABLE_COMPONENT,
  PICKUP_DROP_COMPONENT,
  SIMPLE_COLLISION_COMPONENT,
  TRANSFORM_COMPONENT,
} from '../../shared/actor/index.mjs';
import { releaseElasticTether } from './ElasticTetherMutations.mjs';
import { pickupActor } from './PickupDropMutations.mjs';

/**
 * 叼在嘴上时物件的姿态：把它自身的向上轴摆到玩家正前方，也就是横着衔住。
 * 这既是「叼」该有的样子，也决定了放下时它是躺着落地而不是站着——放下不给
 * 任何冲量，落地姿态完全由离手那一刻的朝向决定。
 */
function carriedRotation(yaw) {
  const half = Math.SQRT1_2;
  return {
    x: Math.cos(yaw) * half,
    y: 0,
    z: -Math.sin(yaw) * half,
    w: half,
  };
}

/** 服务端权威的“拔出、叼住、放下”运动；只遍历组合了 elasticDetach 的 Actor。 */
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
          const holderId = tether.holderPlayerId;
          detachable.pop(direction);
          releaseElasticTether(tether, interactable);
          const holder = world.getActor(holderId);
          // 拔下来的东西**直接变成手上那件物品**：拔蘑菇的人要的是一朵蘑菇，
          // 不是一个还要再按一次才处理得掉的世界物件。装配成功那一刻这个 Actor
          // 就不在世界里了，所以这一轮到此为止——底下那些是给「还躺在世界里的
          // 脱落物」准备的（建刚体、积分重力），对一个已经删掉的 Actor 没有意义。
          if (world.context.stowPulledActor?.(actor, holder)) continue;
          // 揣不走（没登记成物品、物品栏一格都腾不出来）就退回原来那条：
          // 叼在嘴上，等玩家再按一次交互键放下。
          if (!pickupActor(world, actor, holder)) continue;
          if (interactable.enabled) {
            interactable.enabled = false;
            interactable.revision += 1;
          }
        }
      }
      if (!detachable.detached || delta === 0) continue;
      // 叼在嘴上的这一段跟着玩家走，不进刚体世界：它的位置由嘴决定，不由重力决定。
      const holderPickupDrop = actor.parent?.getComponent(PICKUP_DROP_COMPONENT);
      if (holderPickupDrop?.heldActorId === actor.id) {
        this.updateCarriedRotation(actor.parent, motion);
        continue;
      }
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
      this.clampToGround(world, physics, actor.id, motion);
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
      const detachable = actor.requireComponent(ELASTIC_DETACH_COMPONENT);
      const holderPickupDrop = actor.parent?.getComponent(PICKUP_DROP_COMPONENT);
      if (!detachable.detached || holderPickupDrop?.heldActorId === actor.id) continue;
      this.syncActor(
        physics,
        actor,
        actor.requireComponent(DROP_MOTION_COMPONENT),
        actor.requireComponent(TRANSFORM_COMPONENT),
      );
    }
  }

  /**
   * 地面兜底。
   *
   * 地形碰撞网只有陆地顶面，水面格是空的——放进水里的物件穿过水面之后底下
   * 什么都没有，会一直往下掉，刚体也就永远不会休眠。这里按地形的实心高度
   * （水下就是水底）给一层地板，越过就贴住并清掉向下的速度。
   */
  clampToGround(world, physics, actorId, motion) {
    const groundHeightAt = world.context.groundHeightAt;
    if (!groundHeightAt) return;
    const state = physics.getDynamicActorState(actorId);
    if (!state) return;
    const floorY = groundHeightAt(state.position.x, state.position.z) + motion.radius;
    if (state.position.y >= floorY) return;
    physics.setDynamicActorTranslation(actorId, {
      x: state.position.x, y: floorY, z: state.position.z,
    });
    if (state.velocity.y < 0) {
      physics.setDynamicActorVelocity(actorId, {
        x: state.velocity.x, y: 0, z: state.velocity.z,
      });
    }
  }

  /** Attach 已负责位置；这里只维护蘑菇横衔所需的非位置姿态。 */
  updateCarriedRotation(carrier, motion) {
    motion.setRotation(carriedRotation(carrier.yaw));
    motion.velocityX = 0;
    motion.velocityY = 0;
    motion.velocityZ = 0;
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
