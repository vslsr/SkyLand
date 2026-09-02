import { ActorComponent } from '../ActorComponent.mjs';

export const MUSHROOM_POP_COMPONENT = 'mushroomPop';

/** 蘑菇特化行为：监听通用 popped 事件，并为 Rapier 动态刚体提供弹出冲量。 */
export class MushroomPopComponent extends ActorComponent {
  constructor(definition = {}) {
    super(MUSHROOM_POP_COMPONENT);
    this.forwardImpulse = Math.max(0, Number(definition.forwardImpulse) || 0);
    this.upwardImpulse = Math.max(0, Number(definition.upwardImpulse) || 0);
  }

  bind(detachable) {
    return detachable.onPopped((event) => {
      event.impulse.x += event.direction.x * this.forwardImpulse;
      event.impulse.y += this.upwardImpulse;
      event.impulse.z += event.direction.z * this.forwardImpulse;
    });
  }
}
