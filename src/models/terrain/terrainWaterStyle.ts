/** 波峰与岸面之间始终保留的最小高度差，避免动态水面再次看起来平齐。 */
export const STREAMED_WATER_SHORE_CLEARANCE = 0.08;

/** 粗岸线使用真实三角带宽度，不依赖各平台实现不一致的 WebGL linewidth。 */
export const STREAMED_WATER_SHORE_WIDTH = 0.075;
