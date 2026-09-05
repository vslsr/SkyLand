/**
 * 弹道：一条弧的几何，加上沿这条弧的碰撞检测。
 *
 * 住在 shared 是因为三处必须读同一份：蓄力预览线、飞出去那支箭、服务端的命中判定。
 */
export {
  MUZZLE_HEIGHT,
  ballisticArcApex,
  ballisticArcImpact,
  ballisticArcPoint,
  ballisticArcTravel,
} from './ballisticArc.mjs';
export {
  PROJECTILE_ARC_SEGMENTS,
  PROJECTILE_RADIUS,
  sweepProjectileArc,
  sweepProjectileTargets,
} from './projectileSweep.mjs';
