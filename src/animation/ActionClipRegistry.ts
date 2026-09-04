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

/**
 * 一帧姿态。没写的那一项就是不动。
 *
 * 位移写在**角色自己的坐标系**里：`x` 是右，`y` 是上，`z` 是身前。拉弓要往后拉，
 * 而「后」只有在角色朝向里才说得通——写成世界坐标的话，玩家一转身，弓就往错误的
 * 方向拉了。读它的三处（本地玩家、远端玩家、手上那件）各自按自己的 yaw 转一次，
 * 用的是同一个 `rotateActionOffset`。
 */
export interface ActionPose {
  /** 角色坐标系里的位移，米：x 右、y 上、z 身前。 */
  readonly offset?: { readonly x: number; readonly y: number; readonly z: number };
  /** 缩放倍数，1 = 原样。 */
  readonly scale?: number;
}

/**
 * 把姿态位移从角色坐标系转到世界坐标系。
 *
 * 朝向的约定和玩法侧一致：`yaw` 的正前方是 `(sin(yaw), cos(yaw))`（`throwItem`
 * 出手点算的就是它），所以右手方向是 `(cos(yaw), -sin(yaw))`。
 */
export function rotateActionOffset(
  offset: { readonly x: number; readonly y: number; readonly z: number } | undefined,
  yaw: number,
): { x: number; y: number; z: number } | undefined {
  if (!offset) return undefined;
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  return {
    x: offset.x * cos + offset.z * sin,
    y: offset.y,
    z: offset.z * cos - offset.x * sin,
  };
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
  registerActionClip('shoot.charge', 'actor', (phase) => ({
    offset: chargeBodyOffset(phase.ratio, phase.elapsed),
  }));
  registerActionClip('shoot.charge', 'held', (phase) => ({
    offset: chargeHeldOffset(phase.ratio, phase.elapsed),
  }));
  registerActionClip('shoot.fire', 'actor', (phase) => ({
    offset: recoilOffset(phase.ratio, 0.05),
  }));
  registerActionClip('shoot.fire', 'held', (phase) => ({
    offset: recoilOffset(phase.ratio, 0.12),
    // 弹出去那一下弓身回弹，稍微放大一点再落回原样。
    scale: 1 + 0.12 * settle(phase.ratio),
  }));
}

registerBuiltInActionClips();

/**
 * 蓄力那一段的曲线：**往后拉、往下沉，拉满之后开始抖**。
 *
 * 往后拉是这件事本身（弓弦被拉开），往下沉是使劲；拉满之后比例停在 1、秒数继续走，
 * 所以抖动读的是秒数——玩家因此看得出「已经到顶了，再按也没有更强」。
 */
function chargeBodyOffset(ratio: number, elapsed: number): { x: number; y: number; z: number } {
  const pull = smoothPull(ratio);
  return {
    x: strainShake(ratio, elapsed) * 0.4,
    y: -0.03 * pull,
    z: -0.06 * pull,
  };
}

/** 手上那把弓拉得比身体多：拉开的是弦，不是人。 */
function chargeHeldOffset(ratio: number, elapsed: number): { x: number; y: number; z: number } {
  const pull = smoothPull(ratio);
  return {
    x: strainShake(ratio, elapsed),
    y: -0.02 * pull,
    z: -0.14 * pull,
  };
}

/**
 * 打出去那一下的后坐：一记向后的急促位移，随即落回。
 *
 * 用二次衰减而不是正弦：后坐是「一下」，两头一样慢的正弦看起来像被推了一把。
 */
function recoilOffset(ratio: number, amount: number): { x: number; y: number; z: number } {
  return { x: 0, y: 0, z: -amount * settle(ratio) };
}

/** 拉开的进度：前半段拉得快，接近满的时候慢下来——弦越拉越紧。 */
function smoothPull(ratio: number): number {
  const clamped = Math.min(1, Math.max(0, ratio));
  return 1 - (1 - clamped) * (1 - clamped);
}

/** 拉满之后的手抖。没拉满时是 0：抖动说的是「到顶了」，不是「在使劲」。 */
function strainShake(ratio: number, elapsed: number): number {
  if (ratio < 1) return 0;
  return Math.sin(elapsed * 34) * 0.006;
}

/** 一记急促的位移随后落回：1 是刚发生，0 是已经落定。 */
function settle(ratio: number): number {
  const remaining = 1 - Math.min(1, Math.max(0, ratio));
  return remaining * remaining;
}
