import { ActorComponent } from '../ActorComponent.mjs';

export const WEAPON_SHOT_COMPONENT = 'weapon-shot';

/**
 * 这个实体最近撒手的那一下。
 *
 * 它不挂在玩家身上，而是挂在**开火的那个 Actor** 上：谁射的和射手是不是玩家无关。
 * AI 单位射的那一箭要和玩家射的那一箭走同一条复制路径，否则「同一发箭」在系统里
 * 会有两种走法。
 *
 * **只有一个计数**：飞出去那支箭是世界里一件真东西（`ProjectileComponent`），自己飞、
 * 自己撞、撞上了才结算伤害，落在哪儿由它自己说了算。这条因此只回答「他刚才松手了
 * 没有」——接收方拿它抖一下那把弓的弦（`RemoteBowSync`）。
 *
 * 记落点的那一版是箭还只是客户端画的一段动画时留下的：那时每一端都要按同一个落点
 * 自己画一支。箭成了真东西之后，再按落点画一支会让一发箭变成两支，而本地画的那支
 * 还不认识墙。
 *
 * `revision` 是自增计数而不是布尔：一次性事件靠「和上一帧不一样」触发，布尔在
 * 两帧之间翻回去就会被漏掉。它**留着不撤**，接收方按计数去重——只在开火那一帧
 * 下发的话，那一帧丢了那把弓就永远不会抖那一下。
 */
export class WeaponShotComponent extends ActorComponent {
  constructor() {
    super(WEAPON_SHOT_COMPONENT);
    /** 0 表示这个实体一发都还没射过，快照里因此整条不下发。 */
    this.revision = 0;
  }

  /** 记下一发。 */
  record() {
    this.revision += 1;
    return this;
  }

  /** 一发都没射过时返回 undefined：快照里不带一条恒为空的字段。 */
  snapshot() {
    if (this.revision <= 0) return undefined;
    return { revision: this.revision };
  }
}
