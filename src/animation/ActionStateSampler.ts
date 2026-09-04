import { holdRatio } from '../../shared/actor/index.mjs';
import { parseActionState } from '../../shared/animation/actionStates.mjs';
import type { SnapshotActionState } from '../network/protocol';

/**
 * 把一条动作状态换算成「现在演到哪一拍」。
 *
 * 这一层只做**时间换算**，不认识曲线、不认识模型：状态说「从服务端时刻 T 开始、
 * 要 1.2 秒」，这里回答「现在是 0.63」。曲线按这个比例出姿态，见
 * `ActionClipRegistry`。
 *
 * 两端跑的是同一个 `holdRatio`——和长按那圈圆形倒计时是同一个公式，所以圈画到哪，
 * 别人看到的动作就到哪。
 */

/** 采样出来的一拍。没在做什么时是 undefined。 */
export interface ActionPhase {
  /** `<动词>.<相位>`。 */
  readonly state: string;
  readonly verb: string;
  readonly phase: string;
  /** 这次动作用的是哪件物品；手上那件按它挑曲线。 */
  readonly itemType?: string;
  /** [0, 1]。没有确定长度（拉满等松手）时恒为 1。 */
  readonly ratio: number;
  /** 已经演了多久，秒。周期性的曲线读它，不读比例。 */
  readonly elapsed: number;
  /** 这是第几次进入状态；一次性动作靠它区分「又做了一次」。 */
  readonly revision: number;
}

/**
 * 采样一条状态。
 *
 * @param serverNow 服务端时间轴上的**现在**，毫秒。远端玩家要减掉和位置采样同一条
 *   插值延迟，本地玩家不减——理由见 `sampleRemoteAction` / `sampleLocalAction`。
 */
export function sampleActionState(
  action: SnapshotActionState | undefined,
  serverNow: number | undefined,
): ActionPhase | undefined {
  const parsed = action ? parseActionState(action.state) : undefined;
  if (!action || !parsed || serverNow === undefined) return undefined;
  const elapsed = Math.max(0, (serverNow - action.startedAt) / 1000);
  return {
    state: action.state,
    verb: parsed.verb,
    phase: parsed.phase,
    itemType: action.itemType,
    // 没有确定长度的那一段（拉满了等松手）恒为 1：`holdRatio` 对 0 时长就是这么答的。
    ratio: holdRatio(elapsed, action.duration),
    elapsed,
    revision: action.revision,
  };
}

/**
 * 远端玩家的那一拍。
 *
 * **必须减掉和位置采样同一条插值延迟。** 远端玩家的位置是按
 * `renderTime = now - 时钟差 - 插值延迟` 采样的；动作相位不减这一项的话，手上那件
 * 会在模型还没走到位时就先动起来——看起来像两个人。
 */
export function sampleRemoteAction(
  action: SnapshotActionState | undefined,
  serverNow: number | undefined,
  interpolationDelayMs: number,
): ActionPhase | undefined {
  return sampleActionState(
    action,
    serverNow === undefined ? undefined : serverNow - interpolationDelayMs,
  );
}

/**
 * 本地玩家的那一拍。
 *
 * 不减插值延迟：自己的动作不该比自己按下去晚 100 毫秒。本地玩家的位置本来也不走
 * 插值（它是预测出来的）。
 */
export function sampleLocalAction(
  action: SnapshotActionState | undefined,
  serverNow: number | undefined,
): ActionPhase | undefined {
  return sampleActionState(action, serverNow);
}
