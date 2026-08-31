import {
  BUOYANCY_COMPONENT,
  HAZARD_COMPONENT,
  SIMPLE_COLLISION_COMPONENT,
  TRANSFORM_COMPONENT,
  VESSEL_MOTOR_COMPONENT,
} from '../../shared/actor/index.mjs';
import { circleTouchesSimpleCollision } from '../../shared/actor/simpleCollision.mjs';
import { damageVesselPart } from './VesselStateMutations.mjs';

/** 只在 DS 检测礁石半径，客户端视觉碰撞不会直接制造伤害。 */
export class VesselHazardSystem {
  update(world, _deltaSeconds, elapsedSeconds) {
    const nowMs = elapsedSeconds * 1000;
    const vessels = world.query(
      TRANSFORM_COMPONENT,
      BUOYANCY_COMPONENT,
      VESSEL_MOTOR_COMPONENT,
    );
    for (const hazardActor of world.query(TRANSFORM_COMPONENT, HAZARD_COMPONENT)) {
      const hazardTransform = hazardActor.requireComponent(TRANSFORM_COMPONENT);
      const hazard = hazardActor.requireComponent(HAZARD_COMPONENT);
      const hazardCollision = hazardActor.getComponent(SIMPLE_COLLISION_COMPONENT);
      for (const vessel of vessels) {
        const transform = vessel.requireComponent(TRANSFORM_COMPONENT);
        const vesselCollision = vessel.getComponent(SIMPLE_COLLISION_COMPONENT);
        const withinConfiguredRadius = Math.hypot(
          transform.x - hazardTransform.x,
          transform.z - hazardTransform.z,
        ) <= hazard.radius;
        const touchingSimpleCollision = hazardCollision && vesselCollision
          ? circleTouchesSimpleCollision(
            transform,
            Math.min(vesselCollision.halfWidth, vesselCollision.halfLength),
            { collision: hazardCollision, transform: hazardTransform },
          )
          : false;
        if (!withinConfiguredRadius && !touchingSimpleCollision) continue;
        const lastDamageAt = hazard.lastDamageAt.get(vessel.id) ?? Number.NEGATIVE_INFINITY;
        if (nowMs - lastDamageAt < hazard.cooldownMs) continue;
        const buoyancy = vessel.requireComponent(BUOYANCY_COMPONENT);
        if (damageVesselPart(buoyancy, hazard.partId, hazard.damage)) {
          hazard.lastDamageAt.set(vessel.id, nowMs);
        }
      }
    }
  }
}
