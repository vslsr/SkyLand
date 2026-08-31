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
 * 处理会在玩法平面移动的 Actor。当前只有权威船舶属于 mover；碰撞集合最多为
 * 场景允许的 256 个 Actor，不扫描流式世界或未加载 chunk。
 */
export class ActorSimpleCollisionSystem {
  update(world) {
    const collidableActors = world.query(TRANSFORM_COMPONENT, SIMPLE_COLLISION_COMPONENT);
    for (const actor of world.query(
      TRANSFORM_COMPONENT,
      SIMPLE_COLLISION_COMPONENT,
      VESSEL_MOTOR_COMPONENT,
    )) {
      const transform = actor.requireComponent(TRANSFORM_COMPONENT);
      const collision = actor.requireComponent(SIMPLE_COLLISION_COMPONENT);
      const motor = actor.requireComponent(VESSEL_MOTOR_COMPONENT);
      const obstacles = collidableActors
        .filter((candidate) => candidate !== actor && !isRelatedActor(actor, candidate))
        .map((candidate) => ({
          collision: candidate.requireComponent(SIMPLE_COLLISION_COMPONENT),
          transform: candidate.requireComponent(TRANSFORM_COMPONENT),
        }));
      const radius = Math.min(collision.halfWidth, collision.halfLength);
      const resolved = resolveCircleAgainstSimpleCollisions(transform, radius, obstacles);
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
