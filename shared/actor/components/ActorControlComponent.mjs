import { ActorComponent } from '../ActorComponent.mjs';

export const ACTOR_CONTROL_COMPONENT = 'actor-control';

/** 通用的服务端控制权状态；不把具体载具输入耦合进 Actor 所有权。 */
export class ActorControlComponent extends ActorComponent {
  constructor() {
    super(ACTOR_CONTROL_COMPONENT);
    this.ownerPlayerId = null;
    this.inputSequence = 0;
    this.eventSequence = 0;
    this.lastInputAt = Number.NEGATIVE_INFINITY;
    this.revision = 0;
  }

  resetInput() {
    this.inputSequence = 0;
    this.lastInputAt = Number.NEGATIVE_INFINITY;
  }
}
