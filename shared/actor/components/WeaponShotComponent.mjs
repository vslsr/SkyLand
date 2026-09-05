import { ActorComponent } from '../ActorComponent.mjs';

export const WEAPON_SHOT_COMPONENT = 'weapon-shot';

/**
 * 这个实体最近射出去的那一发。
 *
 * 它不挂在玩家身上，而是挂在**开火的那个 Actor** 上：一发箭是谁射的、飞到哪儿，
 * 和射手是不是玩家无关。AI 单位射的那一箭要和玩家射的那一箭走同一条复制路径，
 * 否则「同一发箭」在系统里会有两种走法。
 *
 * 记的是**落点**，不是「往哪个方向射多远」：落点是判定用的那一点，所有人因此画
 * 的是同一条弧；方向加距离要接收方再算一次，而那一次算错了没人会发现。
 *
 * `revision` 是自增计数而不是布尔：一次性事件靠「和上一帧不一样」触发，布尔在
 * 两帧之间翻回去就会被漏掉。它**留着不撤**，接收方按计数去重——只在开火那一帧
 * 下发的话，那一帧丢了这支箭就永远不会出现。
 */
export class WeaponShotComponent extends ActorComponent {
  constructor() {
    super(WEAPON_SHOT_COMPONENT);
    /** 0 表示这个实体一发都还没射过，快照里因此整条不下发。 */
    this.revision = 0;
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.impactX = 0;
    this.impactZ = 0;
    this.ratio = 0;
  }

  /** 记下一发。出手点是射手脚下那一点，抬到手上那一段由表现侧自己加。 */
  record({ x, y, z, impactX, impactZ, ratio }) {
    this.revision += 1;
    this.x = x;
    this.y = y;
    this.z = z;
    this.impactX = impactX;
    this.impactZ = impactZ;
    this.ratio = ratio;
    return this;
  }

  /** 一发都没射过时返回 undefined：快照里不带一条恒为空的字段。 */
  snapshot() {
    if (this.revision <= 0) return undefined;
    return {
      revision: this.revision,
      x: Math.round(this.x * 100) / 100,
      y: Math.round(this.y * 100) / 100,
      z: Math.round(this.z * 100) / 100,
      impactX: Math.round(this.impactX * 100) / 100,
      impactZ: Math.round(this.impactZ * 100) / 100,
      ratio: Math.round(this.ratio * 1000) / 1000,
    };
  }
}
