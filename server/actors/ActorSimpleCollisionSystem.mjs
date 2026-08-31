import {
  SIMPLE_COLLISION_COMPONENT,
  TRANSFORM_COMPONENT,
  VESSEL_MOTOR_COMPONENT,
} from '../../shared/actor/index.mjs';
import { resolveCircleAgainstSimpleCollisions } from '../../shared/actor/simpleCollision.mjs';

function isRelatedActor(first, second) {
  for (let current = first; current; current = current.parent) {
    if (current === second) return true;
  }
  for (let current = second; current; current = current.parent) {
    if (current === first) return true;
  }
  return false;
}

/**
 * 处理会在玩法平面移动的 Actor。当前只有权威船舶属于 mover。
 *
 * 候选优先来自场景的空间划分（world.context.collision）：一条船只会和身边
 * 格子里的碰撞体比对，而不是和房间里全部 Actor 逐个比对，静态的礁石与
 * 流式世界的物件也一并涵盖。没有碰撞世界时退回逐个遍历，单元测试里
 * 直接 new ActorWorld 的用法因此照常可用。
 */
export class ActorSimpleCollisionSystem {
  update(world) {
    const collisionWorld = world.context?.collision;
    const collidableActors = collisionWorld
      ? undefined
      : world.query(TRANSFORM_COMPONENT, SIMPLE_COLLISION_COMPONENT);
    for (const actor of world.query(
      TRANSFORM_COMPONENT,
      SIMPLE_COLLISION_COMPONENT,
      VESSEL_MOTOR_COMPONENT,
    )) {
      const transform = actor.requireComponent(TRANSFORM_COMPONENT);
      const collision = actor.requireComponent(SIMPLE_COLLISION_COMPONENT);
      const motor = actor.requireComponent(VESSEL_MOTOR_COMPONENT);
      const radius = Math.min(collision.halfWidth, collision.halfLength);
      // 自己和挂在自己身上的货箱不参与推出，否则船会被自己的货推走。
      const accept = (candidate) => {
        const other = candidate.actor;
        if (!other) return true;
        return other !== actor && !isRelatedActor(actor, other);
      };
      const resolved = collisionWorld
        ? collisionWorld.resolveCircle(transform, radius, { accept })
        : resolveCircleAgainstSimpleCollisions(
          transform,
          radius,
          collidableActors
            .filter((candidate) => candidate !== actor && !isRelatedActor(actor, candidate))
            .map((candidate) => ({
              collision: candidate.requireComponent(SIMPLE_COLLISION_COMPONENT),
              transform: candidate.requireComponent(TRANSFORM_COMPONENT),
            })),
        );
      const bounds = world.context.bounds;
      if (bounds) {
        resolved.x = Math.max(bounds.minimumX, Math.min(bounds.maximumX, resolved.x));
        resolved.z = Math.max(bounds.minimumZ, Math.min(bounds.maximumZ, resolved.z));
      }
      if (Math.hypot(resolved.x - transform.x, resolved.z - transform.z) <= 1e-7) continue;
      transform.setWorldTransform([resolved.x, transform.y, resolved.z], transform.yaw);
      motor.speed = 0;
    }
  }
}
