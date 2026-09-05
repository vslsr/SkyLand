import {
  ballisticArcApex as sharedApex,
  ballisticArcImpact as sharedImpact,
  ballisticArcPoint as sharedPoint,
  ballisticArcTravel as sharedTravel,
} from '../../shared/ballistics/index.mjs';

/**
 * 那条抛物弧在客户端这一侧的**类型**与转口。
 *
 * 实现已经搬到 `shared/ballistics/ballisticArc.mjs`：加入弹药碰撞之后这条弧同时是
 * 服务端判定的行进路径，两端必须读同一份。这里留下的只有 TypeScript 类型，以及
 * 一层直接转发——渲染侧的 import 路径因此不用改动。
 */

/** 一条弧的全部：两个端点、一个蓄力比例，加上这一箭实际走了多少。 */
export interface BallisticArc {
  readonly originX: number;
  readonly originY: number;
  readonly originZ: number;
  readonly impactX: number;
  readonly impactY: number;
  readonly impactZ: number;
  /** 蓄力比例 [0, 1]。拉得越满弧越平。 */
  readonly ratio: number;
  /**
   * 这一箭沿弧走完的比例 [0, 1]，被墙／地形／实体挡住时小于 1。
   *
   * 省略等同于 1。端点仍然是**没被挡住时**的那一对：挡住只是把这条曲线截短，
   * 不改变它的形状，见 `ballisticArcTravel` 的注释。
   */
  readonly travel?: number;
}

/** 这条弧的弧顶抬多高。距离和蓄力比例一起决定它。 */
export function ballisticArcApex(arc: BallisticArc): number {
  return sharedApex(arc);
}

/** 弧上 `t ∈ [0, 1]` 处那一点，写进 `out`。 */
export function ballisticArcPoint(
  arc: BallisticArc,
  t: number,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  return sharedPoint(arc, t, out);
}

/** 这一箭实际走完弧的百分之多少；没被挡住就是 1。 */
export function ballisticArcTravel(arc: BallisticArc): number {
  return sharedTravel(arc);
}

/** 这一箭真正落在哪儿：弧走到 `travel` 为止的那一点。 */
export function ballisticArcImpact(
  arc: BallisticArc,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  return sharedImpact(arc, out);
}
