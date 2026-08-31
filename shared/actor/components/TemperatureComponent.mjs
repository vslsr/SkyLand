import { ActorComponent } from '../ActorComponent.mjs';

export const TEMPERATURE_COMPONENT = 'temperature';

/** 可受热 Actor 的权威热状态；客户端只复制公开温度，不参与结算。 */
export class TemperatureComponent extends ActorComponent {
  constructor(definition) {
    super(TEMPERATURE_COMPONENT);
    this.ambientTemperature = definition.ambientTemperature;
    this.heatCapacity = definition.heatCapacity;
    this.coolingRate = definition.coolingRate;
    this.temperature = definition.initialTemperature;
    this.revision = 0;
  }
}
