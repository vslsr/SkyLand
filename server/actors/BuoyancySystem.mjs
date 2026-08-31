import {
  BUOYANCY_COMPONENT,
  TRANSFORM_COMPONENT,
} from '../../shared/actor/index.mjs';
import { evaluateVesselBuoyancy } from '../../shared/vesselBuoyancy.mjs';

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

/** 服务端只在浮力 Component 标脏时重算，不采样客户端海浪。 */
export class BuoyancySystem {
  update(world) {
    for (const actor of world.query(TRANSFORM_COMPONENT, BUOYANCY_COMPONENT)) {
      const buoyancy = actor.requireComponent(BUOYANCY_COMPONENT);
      if (!buoyancy.dirty) continue;

      const result = evaluateVesselBuoyancy(buoyancy.parts, {
        minimumBeam: buoyancy.minimumBeam,
        minimumLength: buoyancy.minimumLength,
        maximumTrimRadians: buoyancy.maximumTrimRadians,
      });
      const draftRatio = clamp(result.draftRatio, 0, 1);
      buoyancy.state = result.state;
      buoyancy.draft = buoyancy.minimumDraft
        + (buoyancy.maximumDraft - buoyancy.minimumDraft) * draftRatio;
      buoyancy.staticRoll = result.trimRoll;
      buoyancy.staticPitch = result.trimPitch;
      buoyancy.speedFactor = result.speedFactor;
      buoyancy.revision += 1;
      buoyancy.dirty = false;
    }
  }
}
