/**
 * 吃东西那一段的表现曲线。
 *
 * 玩家模型的抖动和手上那件食物的变小**读同一份曲线**：两边各写一套的话，嚼的
 * 拍子迟早对不上——玩家在抖、食物在另一个节奏上缩，看起来像两件事同时发生，
 * 而不是一件事。
 *
 * 输入只有 `ratio`（这次按住走到了 [0, 1] 的哪里），不是秒数：圈满那一刻就是
 * 服务端扣账那一刻，表现跟着同一个比例走，长按多久都自动对齐。
 *
 * 这一整套都是**纯表现**：它不过网、不上报、不改玩法坐标。抖得对不对不改变
 * 背包里少了几个。
 */

/** 一次吃咬几口。抖动的拍子和食物变小的台阶都按它分。 */
export const CHEW_BITES = 3;

/** 每一口把身体抬多高，米。 */
const CHEW_RISE = 0.035;
/** 每一口左右晃多少，米。比抬起来小一半：吃东西是上下的动作。 */
const CHEW_SWAY = 0.018;
/** 吃到最后一口时食物剩多大。留一点而不是缩到 0：它是被咽下去的，不是化掉的。 */
const CHEW_FINAL_SCALE = 0.35;
/** 咬下去那一下把食物捏扁多少。 */
const CHEW_PINCH = 0.08;

function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0;
  return Math.min(1, Math.max(0, ratio));
}

/** 嚼到第几口（含小数）。0 = 刚放进嘴里，`CHEW_BITES` = 咽下去。 */
function bitePhase(ratio: number): number {
  return clampRatio(ratio) * CHEW_BITES;
}

/** 一口之内的进度，两端平滑：咬合发生在中间，嘴张开与合拢的两头慢一点。 */
function smoothstep(value: number): number {
  return value * value * (3 - 2 * value);
}

/**
 * 玩家模型这一帧的抖动偏移，世界空间的米。
 *
 * 竖直用取绝对值的正弦，每一口一顿；水平错开半拍，免得整只史莱姆变成一条直线上
 * 的往返。
 */
export function chewBodyOffset(ratio: number): { x: number; y: number; z: number } {
  const phase = bitePhase(ratio);
  return {
    x: Math.sin(phase * Math.PI * 2) * CHEW_SWAY,
    y: Math.abs(Math.sin(phase * Math.PI)) * CHEW_RISE,
    z: Math.cos(phase * Math.PI * 2 + 1.1) * CHEW_SWAY,
  };
}

/**
 * 手上那件食物这一帧还剩多大（1 = 原样）。
 *
 * **一口一口地小下去**，不是匀速缩：咬合的那一下掉一截、嘴合上的间隙几乎不动，
 * 所以玩家数得出自己咬了几口。每一口还带一次轻微的捏扁，让「被咬到」这件事在
 * 尺寸之外还有一个瞬间。
 */
export function chewFoodScale(ratio: number): number {
  const phase = bitePhase(ratio);
  const bites = Math.floor(phase);
  const withinBite = phase - bites;
  const eaten = Math.min(1, (bites + smoothstep(withinBite)) / CHEW_BITES);
  const pinch = 1 - Math.sin(withinBite * Math.PI) * CHEW_PINCH;
  return (1 - eaten * (1 - CHEW_FINAL_SCALE)) * pinch;
}
