export const CHARACTER_OFFSET = 0.02;
/**
 * 自动上台阶的最大高度。
 *
 * Rapier 的 autostep 对所有 collider 一视同仁，不区分「地形接缝」和「一块石头」，
 * 所以它必须小于任何应该挡住玩家的东西。地形台地步高是 TERRAIN_HEIGHT_STEP = 1m：
 * 取值一旦接近它，1m 崖壁、货箱、石头就全部退化成免费台阶，跳跃对地形失去意义。
 * 0.35 落在「角色总高 0.84m 的三分之一」这一档，路缘和碎石照样迈过去，1m 崖壁必须
 * 走坡道或起跳（起跳冲量 7、重力 22 的抛物线顶点约 1.11m，够上 1m 台地）。
 *
 * 接缝本身不靠 autostep 兜底：地形是每 chunk 一张 trimesh，同高相邻格共面，
 * 落到台地后 SNAP_TO_GROUND_DISTANCE 负责把 CHARACTER_OFFSET 的 2cm 悬空吸回去。
 */
export const AUTOSTEP_MAX_HEIGHT = 0.35;
export const AUTOSTEP_MIN_WIDTH = 0.15;
export const SNAP_TO_GROUND_DISTANCE = 0.25;
export const MAX_SLOPE_CLIMB_ANGLE = Math.PI / 3;
export const MIN_SLOPE_SLIDE_ANGLE = 50 * Math.PI / 180;
export const GROUND_SNAP_PROBE = 0.1;
/** 浮力只通过固定步速度积分作用于角色，数值单位分别为 s^-2 与 s^-1。 */
export const BUOYANCY_SPRING_STIFFNESS = 48;
export const BUOYANCY_DAMPING = 12;
export const BUOYANCY_SUPPORT_DISTANCE = 0.035;
export const BUOYANCY_SUPPORT_SPEED = 0.4;

export const DEFAULT_CHARACTER_PHYSICS = Object.freeze({
  offset: CHARACTER_OFFSET,
  maximumStepHeight: AUTOSTEP_MAX_HEIGHT,
  minimumStepWidth: AUTOSTEP_MIN_WIDTH,
  snapToGroundDistance: SNAP_TO_GROUND_DISTANCE,
  maximumSlopeClimbAngle: MAX_SLOPE_CLIMB_ANGLE,
  minimumSlopeSlideAngle: MIN_SLOPE_SLIDE_ANGLE,
});

/** Convert the existing feet-based simple collision volume exactly once. */
export function characterDimensionsFromSimpleCollision(collision) {
  const minimumY = Number(collision?.minimumY) || 0;
  const maximumY = Number(collision?.maximumY);
  const height = Number.isFinite(maximumY) ? Math.max(0.02, maximumY - minimumY) : 0.84;
  return {
    radius: Math.max(0.01, Math.min(
      Number(collision?.halfWidth) || 0.42,
      Number(collision?.halfLength) || 0.42,
    )),
    halfHeight: height * 0.5,
  };
}
