import { ActorComponent } from '../ActorComponent.mjs';
import { parseActionState } from '../../animation/actionStates.mjs';

export const ACTION_STATE_COMPONENT = 'actionState';

/** 没在做什么。这时整条状态不下发。 */
export const NO_ACTION = undefined;

/**
 * 「这个 Actor 正在做什么」的那一条状态。
 *
 * 它是**动作表现的复制通道**：吃东西那段抖动、弹弓拉弓那一秒，别人要看得见，靠的
 * 就是这一条。过网的是状态（谁、在做什么、用哪件东西、从什么时候开始、多长），
 * 不是每一帧的姿态——姿态是渲染侧按同一份曲线推出来的。
 *
 * **它是权威状态的投影，不是第二份真相。** 写它的只有 `ItemAbilityRuntime` 那三个
 * 已经存在的时刻（授予按下 / 激活 / 收回），组件自己不判断任何事。两份真相迟早会在
 * 某条路径上分家：用光了、被打断、切走手持物。
 *
 * 做成组件而不是让快照直接读 `player.itemAbility`，是因为将来受击、砍树、上下船这些
 * 动作根本不经过物品能力，但它们要走的是同一条通道。谁想让一个动作被别人看见，
 * 就往这里写一次。
 *
 * 同一时刻只有一条：一个身体同时只演一件事。两条同时来时按 `priority` 取高的，
 * 低的直接不进——不做队列，玩家看不出「排着队的动作」和「被吃掉的动作」的区别，
 * 而队列会让表现比玩法晚上几百毫秒。
 */
export class ActionStateComponent extends ActorComponent {
  constructor() {
    super(ACTION_STATE_COMPONENT);
    /** @type {string | undefined} `<动词>.<相位>`；没在做什么时是 undefined。 */
    this.state = NO_ACTION;
    /** @type {string | undefined} 这次动作用的是哪件物品。 */
    this.itemType = undefined;
    /** 权威开始时刻，毫秒，和快照的 `serverTime` 同一条时间轴。 */
    this.startedAt = 0;
    /** 走完一整轮多久，秒。0 = 没有确定长度（拉满了等松手那一段）。 */
    this.duration = 0;
    /** 越大越压得住别人。受击 > 使用物品。 */
    this.priority = 0;
    /**
     * 每进入一次新状态 +1。
     *
     * 一次性动作靠它触发，也靠它区分「连着做了两次同一件事」——两次之间状态字段
     * 完全一样，只有它在变。bool 或者「状态变了没有」都会把第二次漏掉。
     */
    this.revision = 0;
  }

  get isActive() {
    return this.state !== NO_ACTION;
  }

  /**
   * 进入一个状态。
   *
   * @param {string} state `<动词>.<相位>`
   * @param {{ itemType?: string, startedAt?: number, duration?: number, priority?: number }} options
   * @returns 状态是否真的变了（进不去时返回 false）
   */
  enter(state, { itemType, startedAt = 0, duration = 0, priority = 0 } = {}) {
    if (!parseActionState(state)) return false;
    // 正在演的那条优先级更高时不打断它：一个身体同时只演一件事。
    if (this.isActive && priority < this.priority) return false;
    this.state = state;
    this.itemType = typeof itemType === 'string' ? itemType : undefined;
    this.startedAt = Number.isFinite(startedAt) ? startedAt : 0;
    this.duration = Number.isFinite(duration) && duration > 0 ? duration : 0;
    this.priority = priority;
    this.revision += 1;
    return true;
  }

  /** 回到「没在做什么」。 */
  clear() {
    if (!this.isActive) return false;
    this.state = NO_ACTION;
    this.itemType = undefined;
    this.startedAt = 0;
    this.duration = 0;
    this.priority = 0;
    this.revision += 1;
    return true;
  }

  /**
   * 下发用的紧凑形态；没在做什么时是 undefined——整条字段不进快照。
   *
   * `revision` 一直发：一次性动作靠它触发，而它在两次同样的动作之间是唯一的差别。
   */
  snapshot() {
    if (!this.isActive) return undefined;
    return {
      state: this.state,
      ...(this.itemType ? { itemType: this.itemType } : {}),
      startedAt: this.startedAt,
      duration: this.duration,
      revision: this.revision,
    };
  }
}
