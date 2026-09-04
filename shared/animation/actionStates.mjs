/**
 * 动作状态的词汇表。两端共读。
 *
 * 一个动作状态是 `<动词>.<相位>`：动词来自物品目录的 `use.action`（eat / shoot /
 * tool / throw），相位是使用能力那三个**已经存在**的时刻。它不是「播哪个动画」，
 * 而是「这个人现在在做什么」——播什么由渲染侧按状态挑曲线，见
 * `src/animation/ActionClipRegistry.ts`。
 *
 * 两段式是刻意的：渲染侧先按整条 id 找曲线，找不到就退回只按动词找。这样「弹弓
 * 拉弓」可以有自己的一条，而「一切蓄力的通用抖动」只写一份，新物品不写曲线也不会
 * 一动不动。
 *
 * 状态过网、曲线不过网，这是这条通道的全部要点：过边界的是玩法量（谁、在做什么、
 * 从什么时候开始），每一帧的姿态是渲染侧按同一份曲线推出来的。
 */

/**
 * 相位。就是使用能力的三个时刻，不新造。
 *
 * - `hold`：按住走倒计时，圈满那一刻激活（吃东西的那一段）。
 * - `charge`：按住蓄力，圈满**停住等松手**，松手才是那一下。
 * - `fire`：结算那一下本身。它有确定的表现时长，播完就回到没有状态。
 */
export const ACTION_PHASES = Object.freeze(['hold', 'charge', 'fire']);

/**
 * 一次结算（`fire`）演多久，秒。
 *
 * 这是**渲染常量**，不是物品目录里的字段：它说的是「这段表现演多久」，和玩法判定
 * 无关——判定在圈满或松手那一刻就完成了。写进物品目录会让人以为改它能改玩法。
 *
 * 没登记的动词退回 `DEFAULT_FIRE_SECONDS`。
 */
export const FIRE_SECONDS = Object.freeze({
  eat: 0.35,
  shoot: 0.28,
  tool: 0.3,
  throw: 0.32,
});

export const DEFAULT_FIRE_SECONDS = 0.3;

/** 拼一条状态 id。动词或相位说不通时返回 undefined——宁可不进状态，也不进一个假的。 */
export function actionStateId(verb, phase) {
  if (typeof verb !== 'string' || !/^[a-z][a-z0-9-]*$/.test(verb)) return undefined;
  return ACTION_PHASES.includes(phase) ? `${verb}.${phase}` : undefined;
}

/** 拆开一条状态 id。给渲染侧按动词回退用。 */
export function parseActionState(state) {
  if (typeof state !== 'string') return undefined;
  const [verb, phase] = state.split('.');
  return actionStateId(verb, phase) ? { verb, phase } : undefined;
}

/** 这一次结算演多久。 */
export function fireSeconds(verb) {
  return FIRE_SECONDS[verb] ?? DEFAULT_FIRE_SECONDS;
}
