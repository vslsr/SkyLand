export const HYBRID_SLIME_CENTER_HEIGHT_RATIO = 0.46;
export const HYBRID_SLIME_PLANAR_RADIUS_RATIO = 0.82;
export const HYBRID_SLIME_VERTICAL_RADIUS_RATIO = 0.44;
export const HYBRID_SLIME_FLOOR_HEIGHT_RATIO = 0.018;

// 大于 1 会让上表面在外圈更长时间保持低位，形成贴地的软边而不是悬空椭球。
const RIM_SAG_EXPONENT = 1.28;

export function hybridSlimeFloorY(radius: number): number {
  return radius * HYBRID_SLIME_FLOOR_HEIGHT_RATIO;
}

/**
 * 闭合球拓扑的上半部形成穹顶，下半部压成贴地软底。
 * 这样仍沿用同一份固定顶点/索引预算，但最大平面半径会真正落在地面边缘。
 */
export function hybridSlimeRestY(
  radius: number,
  directionY: number,
  verticalScale = 1,
): number {
  const floorY = hybridSlimeFloorY(radius);
  const upperDirection = Math.max(0, Math.min(1, directionY));
  const topHeight = radius * (
    HYBRID_SLIME_CENTER_HEIGHT_RATIO
    + HYBRID_SLIME_VERTICAL_RADIUS_RATIO
    - HYBRID_SLIME_FLOOR_HEIGHT_RATIO
  );
  return floorY + Math.pow(upperDirection, RIM_SAG_EXPONENT) * topHeight * verticalScale;
}
