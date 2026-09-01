import {
  BUOYANCY_COMPONENT,
  recalculateBuoyancyComponent,
  TRANSFORM_COMPONENT,
} from '../../shared/actor/index.mjs';

/** 服务端只在浮力 Component 标脏时重算，不采样客户端海浪。 */
export class BuoyancySystem {
  update(world) {
    for (const actor of world.query(TRANSFORM_COMPONENT, BUOYANCY_COMPONENT)) {
      const buoyancy = actor.requireComponent(BUOYANCY_COMPONENT);
      if (!buoyancy.dirty) continue;

      recalculateBuoyancyComponent(buoyancy);
    }
  }
}
