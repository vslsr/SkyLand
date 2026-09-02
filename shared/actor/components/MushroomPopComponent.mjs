import { ActorComponent } from '../ActorComponent.mjs';

export const MUSHROOM_POP_COMPONENT = 'mushroomPop';

/** 蘑菇特化行为：监听通用 popped 事件，并为 Rapier 动态刚体提供弹出冲量。 */
export class MushroomPopComponent extends ActorComponent {
  constructor(definition = {}) {
    super(MUSHROOM_POP_COMPONENT);
    this.forwardImpulse = Math.max(0, Number(definition.forwardImpulse) || 0);
    this.upwardImpulse = Math.max(0, Number(definition.upwardImpulse) || 0);
    /** 拔断瞬间绕水平轴的翻滚冲量；0 表示只弹出、不翻。 */
    this.spinImpulse = Math.max(0, Number(definition.spinImpulse) || 0);
  }

  bind(detachable) {
    return detachable.onPopped((event) => {
      event.impulse.x += event.direction.x * this.forwardImpulse;
      event.impulse.y += this.upwardImpulse;
      event.impulse.z += event.direction.z * this.forwardImpulse;
      // 翻滚轴垂直于弹出方向且水平：菌盖朝前翻过去，落地后顺着同一方向滚。
      event.torqueImpulse.x += event.direction.z * this.spinImpulse;
      event.torqueImpulse.z += -event.direction.x * this.spinImpulse;
    });
  }
}
