export const CHARACTER_OFFSET = 0.02;
export const AUTOSTEP_MAX_HEIGHT = 1.05;
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
