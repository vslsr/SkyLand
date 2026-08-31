import { ActorComponent } from '../ActorComponent.mjs';

export const ACTOR_RESIDENCY_COMPONENT = 'actorResidency';

/** 高数量 Actor 的活动/休眠状态；dormant 本身是离开 ActorWorld 的记录。 */
export class ActorResidencyComponent extends ActorComponent {
  constructor(definition = {}) {
    super(ACTOR_RESIDENCY_COMPONENT);
    this.state = definition.state === 'sleeping' ? 'sleeping' : 'active';
    this.sleepDelaySeconds = Math.max(0, Number(definition.sleepDelaySeconds) || 1);
    this.dormantDelaySeconds = Math.max(0, Number(definition.dormantDelaySeconds) || 3);
    this.dormantEligible = definition.dormantEligible !== false;
    this.stateAgeSeconds = 0;
    this.revision = 0;
  }

  setState(state) {
    if ((state !== 'active' && state !== 'sleeping') || state === this.state) return false;
    this.state = state;
    this.stateAgeSeconds = 0;
    this.revision += 1;
    return true;
  }
}
