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
    /**
     * 咬出来的形变有多尖。牙齿的默认值是 1：咬住是在一处捏出一个尖，而不是把
     * 整只史莱姆推成一个圆包。留成参数是给之后的钝口外力（吸盘、抓手）用的。
     */
    this.pinch = Math.max(0, Math.min(1, finiteOr(definition.pinch, 1)));
    /**
     * 牙齿捏起来的那块皮有多深（米）。
     *
     * 咬住看得见不能靠两个人恰好隔着一段距离：外壳半径 0.95 m 而角色碰撞半径只有
     * 0.52 m，贴身咬的时候嘴其实埋在被咬者的外壳里，纯几何算出来的位移是零。
     * 捏起一块皮是牙的属性，所以深度写在这儿。
     */
    this.gripDepth = Math.max(0, finiteOr(definition.gripDepth, 0.35));
    /**
     * 缰绳：被咬住的人能挣多远。绳长以内完全自由，出了绳长每多走一米就多拽回
     * 一分，所以是「越走越拉不动」而不是撞上一堵看不见的墙。刚度乘固定步长
     * 超过 2 这个弹簧就会自激振荡，所以目录把它卡在 120 以内。
     */
    this.leashSlack = Math.max(0, finiteOr(definition.leashSlack, 0.2));
    this.leashStiffness = Math.max(0, finiteOr(definition.leashStiffness, 90));
    /** 径向阻尼。没有它缰绳会形成极限环，人在绳长附近来回荡而不是停在绳边上。 */
    this.leashDamping = Math.max(0, finiteOr(definition.leashDamping, 14));
    /**
     * 拖带强度（每秒收敛率）。绳绷紧时被咬者的速度按它收敛到咬人者的速度上，
     * 所以拖拽赢过被咬者自己的驱动——挣扎只能改变被拖走的姿势。
     */
    this.leashCarry = Math.max(0, finiteOr(definition.leashCarry, 40));
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
