import { ActorComponent } from '../ActorComponent.mjs';

export const BITE_COMPONENT = 'bite';

function finiteOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * 能咬住别的软体的一张嘴。
 *
 * 它只负责「咬住谁」这一件事：判定用的距离与朝向阈值在这里，形变本身由被咬者的
 * `SoftBodyDeformationComponent` 持有。挂点复用 `PickupDropComponent` 的口部——
 * 嘴只有一张，叼蘑菇和咬人用的是同一个。
 */
export class BiteComponent extends ActorComponent {
  constructor(definition = {}) {
    super(BITE_COMPONENT);
    /** 嘴够得着的距离（米）。 */
    this.range = Math.max(0, finiteOr(definition.range, 1.8));
    /** 得大致朝着对方：单位连线与正前方的点积下限，1 是正对，0 是侧面。 */
    this.facingDot = finiteOr(definition.facingDot, 0.15);
    this.targetActorId = null;
  }

  bite(actorId) {
    if (!actorId || this.targetActorId) return false;
    this.targetActorId = actorId;
    return true;
  }

  release() {
    if (!this.targetActorId) return false;
    this.targetActorId = null;
    return true;
  }
}
