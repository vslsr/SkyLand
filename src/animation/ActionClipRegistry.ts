import { chewBodyOffset, chewFoodScale } from '../player/chewAnimation';
import type { ActionPhase } from './ActionStateSampler';

/**
 * 「一个动作状态演成什么样」的注册表。
 *
 * 和服务端那张 `ItemUseActions`（动词 → 世界效果）是对称的一对：那边说这一下做成了
 * 什么，这边说这一下看起来是什么样。两张表都按同一个动词分档，所以「弹丸怎么飞」和
 * 「拉弓的手怎么抖」可以由两个人分头写，互不认识。
 *
 * 曲线是**纯函数**：输入一拍（比例、已经演了多久、用的哪件物品），输出一份姿态偏移。
 * 它不碰 DOM、不碰 three、不读时间——所以两个部件（身体和手上那件）可以读同一份，
 * 而这正是它们能嚼在同一拍上的原因。
 *
 * 查找按 `<动词>.<相位>` 精确匹配，找不到再退回只按动词。这样「弹弓拉弓」能有自己的
 * 一条，而「一切蓄力的通用抖动」只写一份；两条都没有就不动——目录里先有一件新物品、
 * 曲线后补是常态，那时它该安静地什么都不做，而不是报错。
 */

/** 谁在演：做动作的身体，还是它手上那件。 */
export type ActionClipRole = 'actor' | 'held';

/** 一帧姿态。没写的那一项就是不动。 */
export interface ActionPose {
  /** 世界空间的位移，米。 */
  readonly offset?: { readonly x: number; readonly y: number; readonly z: number };
  /** 缩放倍数，1 = 原样。 */
  readonly scale?: number;
}

export type ActionClip = (phase: ActionPhase) => ActionPose;

const clips = new Map<string, ActionClip>();

function key(state: string, role: ActionClipRole): string {
  return `${state}#${role}`;
}

/**
 * 登记一条曲线。
 *
 * @param state `<动词>.<相位>`（`eat.hold`），或者只写动词（`eat`）当作那个动词的兜底。
 */
export function registerActionClip(
  state: string,
  role: ActionClipRole,
  clip: ActionClip,
): () => void {
  const id = key(state, role);
  // 两处同时认领同一条是配置事故，不是「后来的覆盖前面的」：悄悄覆盖之后，
  // 演的是哪一条要靠加载顺序猜。
  if (clips.has(id)) throw new Error(`动作曲线已经有人登记了：${id}`);
  clips.set(id, clip);
  return () => { if (clips.get(id) === clip) clips.delete(id); };
}

/** 这一拍、这个角色该摆成什么样；没人登记就是不动。 */
export function sampleActionPose(
  phase: ActionPhase | undefined,
  role: ActionClipRole,
): ActionPose | undefined {
  if (!phase) return undefined;
  const clip = clips.get(key(phase.state, role)) ?? clips.get(key(phase.verb, role));
  return clip?.(phase);
}

/** 测试用：把注册表清空，免得两份用例互相看见对方登记的曲线。 */
export function resetActionClips(): void {
  clips.clear();
  registerBuiltInActionClips();
}

/**
 * 内置的那几条。
 *
 * **吃东西**：身体每一口一顿地抖，手上那件一口口小下去——两边读的是同一份
 * `chewAnimation`，各写一套的话拍子迟早对不上，看起来像两件事同时发生。
 *
 * 咽下去那一下（`eat.fire`）没有单独的曲线：嚼完就是咽下去，再补一个弹跳只会让
 * 「结束」这件事发生两次。
 */
function registerBuiltInActionClips(): void {
  registerActionClip('eat.hold', 'actor', (phase) => ({ offset: chewBodyOffset(phase.ratio) }));
  registerActionClip('eat.hold', 'held', (phase) => ({
    offset: chewBodyOffset(phase.ratio),
    scale: chewFoodScale(phase.ratio),
  }));
}

registerBuiltInActionClips();
