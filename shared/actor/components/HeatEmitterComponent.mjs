import { ActorComponent } from '../ActorComponent.mjs';

export const HEAT_EMITTER_COMPONENT = 'heat-emitter';

/** 篝火、熔炉等不依赖燃料结算的稳定热源。 */
export class HeatEmitterComponent extends ActorComponent {
  constructor(definition) {
    super(HEAT_EMITTER_COMPONENT);
    this.power = definition.power;
    this.radius = definition.radius;
    this.enabled = definition.enabled;
  }
}
