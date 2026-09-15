/**
 * 局部避障（RVO / 相互速度障碍）的全局约定。
 *
 * 这一层解决的是 A* 解决不了的那一半问题：**路是对的，人挤在一起**。
 * 搜索给出的是一条穿过静态世界的折线，它不认识别的会走路的生物——两只同时
 * 沿着同一条路走的生物，各自的路都是最优的，走起来却是一只顶着另一只。
 *
 * 所以分工是固定的两层，和搜索那一层一样不许混：
 *
 * | 层 | 频率 | 认识谁 | 产出 |
 * | --- | --- | --- | --- |
 * | `NavPathfinder` | 偶尔一次，有预算 | 静态世界（地形、墙、水） | 一条折线 |
 * | `LocalAvoidance` | 每 tick 每只 | 附近的其它 agent | 这一步往哪儿偏 |
 *
 * 避障**只改这一步的方向，不改路**。反过来（把别的生物写进代价图再重寻）
 * 是把每 tick 的几十条算术换成每 tick 一次 A*，一个房间里二十只生物就能把
 * tick 预算烧光。
 *
 * ## 数值为什么按半径写
 *
 * 除 `timeHorizonSeconds` 外的每一项都是**相对自身半径的倍数**，不是米。
 * 写成绝对米的话，一只 0.3 米的小生物和一只 1.5 米的大生物要各配一套数，
 * 而它们想要的其实是同一个手感：「离我三四个身位内的邻居要让」。
 */

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveOr(value, fallback) {
  const number = finiteOr(value, fallback);
  return number > 0 ? number : fallback;
}

export const DEFAULT_AVOIDANCE = Object.freeze({
  /**
   * 预测碰撞的时间窗口，秒。
   *
   * 避障的作用半径不能只看体型：一只每秒走 4 米的生物，用「三个身位」当半径
   * 意味着它发现邻居时已经撞上了。实际半径取「体型倍数」与「这段时间里能走
   * 多远」中较大的那个——跑得快的看得远，站着的只管身边。
   */
  timeHorizonSeconds: 1.5,
  /** 邻居搜索半径 = 自身半径 × 它。超出这个范围的邻居这一 tick 与我无关。 */
  neighborRadiusScale: 5,
  /** 分离力作用半径 = 自身半径 × 它。比搜索半径小：远处的邻居只统计，不推我。 */
  separationRadiusScale: 3.5,
  /**
   * 最多让几个邻居参与受力。
   *
   * 这是这套算法在密集人群里成立的理由：三十只挤在一起时，每只只看最近的六只，
   * 成本是 O(n·K) 而不是 O(n²)。取最近的六个而不是随便六个——真正推着我走的
   * 永远是最近的那几只，再远的加进来只会把方向拉平。
   */
  maxNeighbors: 6,
  /**
   * 径向分离力的权重（相对前进方向）。
   *
   * 比 1 大得多是有意的：邻居越近合力越大，于是「别挤」在贴身时压过「往前走」，
   * 而在空旷处几乎不起作用。两者同权的话，人群会一边互相挤一边硬往前顶。
   */
  separationWeight: 2.4,
  /**
   * 切向绕行力的权重。
   *
   * **没有它的话正前方的挡路者是一个死结**：纯径向的斥力在正前方时与前进方向
   * 恰好反向，合力永远落在同一条直线上——只有前进、停住、后退三种结果，没有
   * 任何横向分量，于是一只生物会顶着不动的挡路者原地推到天荒地老。给转向力
   * 一个垂直于前进方向的分量，它才会从旁边滑过去。
   */
  tangentWeight: 2.2,
  /** 通行走廊余量 = 自身半径 × 它。横向错得比「两个半径 + 余量」还开就不算挡路。 */
  corridorPadScale: 0.375,
  /** 横向偏移小于「自身半径 × 它」视为正对着，此时按统一左右手规则选边。 */
  headOnEpsilonScale: 0.03,
  /**
   * 挡路者自己没在走时的切向加成。
   *
   * 它不会让路，避让责任就全在我这边。少了这一条，一只站着不动的生物面前会
   * 慢慢排起队。
   */
  staticBoost: 1.7,
  /**
   * 站定的生物之间要不要互相推开，以及推多快（米每秒）。
   *
   * 0 表示不推。追到同一个玩家面前站定的几只生物会重叠成一坨，而它们这时
   * 手上都没有路——不给一个小的分离速度的话，避障对这一刻毫无作用。
   */
  idleSeparationSpeed: 0.6,
});

/**
 * @typedef {typeof DEFAULT_AVOIDANCE} AvoidanceConfig
 */

/**
 * 按 `DEFAULT_AVOIDANCE` 补全一份配置。上界是保证算法不发散的硬约束，不是口味：
 * 权重过大时转向会在两侧之间来回过冲，看起来是一群抽搐的生物。
 *
 * @param {Partial<AvoidanceConfig>} [options]
 * @returns {AvoidanceConfig}
 */
export function createAvoidanceConfig(options = {}) {
  const source = options ?? {};
  return Object.freeze({
    timeHorizonSeconds: Math.min(8, positiveOr(source.timeHorizonSeconds, DEFAULT_AVOIDANCE.timeHorizonSeconds)),
    neighborRadiusScale: Math.min(32, positiveOr(source.neighborRadiusScale, DEFAULT_AVOIDANCE.neighborRadiusScale)),
    separationRadiusScale: Math.min(
      32,
      positiveOr(source.separationRadiusScale, DEFAULT_AVOIDANCE.separationRadiusScale),
    ),
    maxNeighbors: Math.max(1, Math.min(32, Math.round(positiveOr(source.maxNeighbors, DEFAULT_AVOIDANCE.maxNeighbors)))),
    separationWeight: Math.max(0, Math.min(16, finiteOr(source.separationWeight, DEFAULT_AVOIDANCE.separationWeight))),
    tangentWeight: Math.max(0, Math.min(16, finiteOr(source.tangentWeight, DEFAULT_AVOIDANCE.tangentWeight))),
    corridorPadScale: Math.max(0, Math.min(8, finiteOr(source.corridorPadScale, DEFAULT_AVOIDANCE.corridorPadScale))),
    headOnEpsilonScale: Math.max(
      0,
      Math.min(1, finiteOr(source.headOnEpsilonScale, DEFAULT_AVOIDANCE.headOnEpsilonScale)),
    ),
    staticBoost: Math.max(1, Math.min(8, finiteOr(source.staticBoost, DEFAULT_AVOIDANCE.staticBoost))),
    idleSeparationSpeed: Math.max(
      0,
      Math.min(8, finiteOr(source.idleSeparationSpeed, DEFAULT_AVOIDANCE.idleSeparationSpeed)),
    ),
  });
}
