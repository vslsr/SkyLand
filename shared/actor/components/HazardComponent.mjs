import { ActorComponent } from '../ActorComponent.mjs';

export const HAZARD_COMPONENT = 'hazard';

/** 静态危险物配置；每艘载具的冷却时间只存在服务端运行态。 */
export class HazardComponent extends ActorComponent {
  constructor(definition) {
    super(HAZARD_COMPONENT);
    this.radius = definition.radius;
    this.damage = definition.damage;
    this.cooldownMs = definition.cooldownMs;
    this.partId = definition.partId;
    this.lastDamageAt = new Map();
  }
}
