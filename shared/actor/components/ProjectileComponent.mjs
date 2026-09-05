import { ActorComponent } from '../ActorComponent.mjs';

export const PROJECTILE_COMPONENT = 'projectile';

/**
 * 一枚飞在空中的弹药（设计稿 `@w 木弓` 的 `A`）。
 *
 * **它为什么是 Actor 而不是一段表现**：命中要在**箭真的到了**那一刻结算。松手就
 * 结算的老做法下，箭穿过墙、穿过地形、穿过站在半路上的人，因为那三样东西根本
 * 没有机会说话——判定在它们之前就已经做完了。要让它们说得上话，这一箭必须真的
 * 在世界里飞：有位置、有 tick、有沿途的碰撞查询，所以它是 Actor。
 *
 * **弧存在这里，不是速度**。整条抛物线在射出那一刻就定下来了（出手点、名义落点、
 * 蓄力比例），飞行只是沿它推进 `travel ∈ [0, 1]`。这样做的理由是**同一条曲线**：
 * 蓄力时那条白线、飞出去这支箭、服务端扫掠的路径读的是同一份 `ballisticArc`。
 * 改存速度加重力的话，三处各积分一遍，误差会让线和箭慢慢分开。
 *
 * 伤害不存成一个数，而是存「哪件武器、蓄力多少」：命中那一刻再用共享的
 * `weaponDamage` 结算，于是标签倍率（`Actor.Build` 之类）和近战走的是同一份表。
 */
export class ProjectileComponent extends ActorComponent {
  constructor(definition = {}) {
    super(PROJECTILE_COMPONENT);
    /** 名义弧：没被挡住时从出手点到落点的那一条。飞行途中不变。 */
    this.originX = finite(definition.originX);
    this.originY = finite(definition.originY);
    this.originZ = finite(definition.originZ);
    this.impactX = finite(definition.impactX);
    this.impactY = finite(definition.impactY);
    this.impactZ = finite(definition.impactZ);
    /** 蓄力比例 [0, 1]。弧顶按它抬，伤害也按它算。 */
    this.ratio = clamp01(definition.ratio);
    /** 飞行速度，米每秒。射程越远飞得越久，速度是同一个。 */
    this.speed = positive(definition.speed, 34);
    /** 扫掠半径，米。见 `PROJECTILE_RADIUS`。 */
    this.radius = positive(definition.radius, 0.08);
    /** 再快的一箭也要看得见：飞行时间的下限，秒。 */
    this.minimumFlightSeconds = positive(definition.minimumFlightSeconds, 0.12);
    /** 停下之后再留多久才收走，秒。让眼睛跟得上「插在那儿了」。 */
    this.lingerSeconds = Math.max(0, finite(definition.lingerSeconds, 1.6));
    /** 射出它的那一个。射出去的东西打不到射出它的人。 */
    this.ownerActorId = definition.ownerActorId ?? undefined;
    /** 命中那一刻用来结算伤害：哪件武器 + 刚才那份蓄力。 */
    this.weaponItemType = definition.weaponItemType ?? undefined;

    /** 已经走完弧的百分之多少。 */
    this.travel = 0;
    /** 停下了没有；停下之后不再推进，只等 `lingerSeconds` 走完。 */
    this.stopped = false;
    /** 停下的那一刻（服务端秒）。`Number.POSITIVE_INFINITY` 表示还在飞。 */
    this.stoppedAt = Number.POSITIVE_INFINITY;
  }

  /** 这条弧水平方向有多长。飞行时长按它和速度算。 */
  get horizontalDistance() {
    return Math.hypot(this.impactX - this.originX, this.impactZ - this.originZ);
  }

  /** 走完整条弧要多久，秒。 */
  get flightSeconds() {
    return Math.max(this.minimumFlightSeconds, this.horizontalDistance / this.speed);
  }

  /** 这一箭停在这儿。`travel` 就是它真正的落点，之后不再推进。 */
  stop(travel, nowSeconds) {
    this.travel = clamp01(travel);
    this.stopped = true;
    this.stoppedAt = Number(nowSeconds) || 0;
  }
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}
