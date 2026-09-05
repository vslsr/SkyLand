/**
 * 那条抛物弧本身（设计稿 `@w 木弓` 的 `A`）。
 *
 * 蓄力时画出来的白线、松手之后飞出去的那支箭，走的必须是**同一条弧**——两处各
 * 算一遍的话，箭会从线旁边擦过去，而玩家看的就是「我瞄的那条线」。所以弧只在这
 * 里定义一次，预览和飞行都来问它要点。
 *
 * 它不是判定：判定只认落点与半径（`shared/items/weaponStrike.mjs` 反解的那一点），
 * 这条弧是把同一个落点连起来的一段表现曲线，所以它住在渲染世界这一侧。
 */

/** 一条弧的全部：两个端点加一个蓄力比例。 */
export interface BallisticArc {
  readonly originX: number;
  readonly originY: number;
  readonly originZ: number;
  readonly impactX: number;
  readonly impactY: number;
  readonly impactZ: number;
  /** 蓄力比例 [0, 1]。拉得越满弧越平。 */
  readonly ratio: number;
}

/** 弧顶最高抬到射程的几分之一。拉满时最平，轻放时最吊。 */
const APEX_RATIO = 0.22;

/** 这条弧的弧顶抬多高。距离和蓄力比例一起决定它。 */
export function ballisticArcApex(arc: BallisticArc): number {
  const distance = Math.hypot(arc.impactX - arc.originX, arc.impactZ - arc.originZ);
  return distance * APEX_RATIO * (1 - arc.ratio * 0.55);
}

/**
 * 弧上 `t ∈ [0, 1]` 处那一点。
 *
 * 水平方向匀速推进、竖直方向在两端连线上叠一条标准抛物线（两端为 0、中间最高）。
 * 写进 `out` 而不是返回一个新对象：飞行中的箭每帧都要问它要两次（当前点与前一点，
 * 用来求朝向），每帧新建对象只是白白喂给 GC。
 */
export function ballisticArcPoint(
  arc: BallisticArc,
  t: number,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const apex = ballisticArcApex(arc);
  out.x = arc.originX + (arc.impactX - arc.originX) * t;
  out.y = arc.originY + (arc.impactY - arc.originY) * t + apex * 4 * t * (1 - t);
  out.z = arc.originZ + (arc.impactZ - arc.originZ) * t;
  return out;
}
