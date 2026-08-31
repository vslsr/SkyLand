import { ActorComponent } from '../ActorComponent.mjs';

export const COMBUSTIBLE_COMPONENT = 'combustible';

/** 达到燃点后消耗燃料并转化为局部热源。 */
export class CombustibleComponent extends ActorComponent {
  constructor(definition) {
    super(COMBUSTIBLE_COMPONENT);
    this.ignitionTemperature = definition.ignitionTemperature;
    this.extinguishTemperature = definition.extinguishTemperature;
    this.maximumFuel = definition.fuel;
    this.fuel = definition.fuel;
    this.burnRate = definition.burnRate;
    this.heatOutput = definition.heatOutput;
    this.heatRadius = definition.heatRadius;
    this.burning = false;
    this.revision = 0;
  }
}
