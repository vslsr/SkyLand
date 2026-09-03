/**
 * 骨骼腿史莱姆的身体与腿的比例关系。
 *
 * 只有一件事需要两侧一致：**身体挂在髋点上方多高**。渲染侧要按它摆
 * `bodyRoot`，权威碰撞与玩家胶囊要按它算总高。写成一个常量而不是在三处各写一个
 * 1.55，是因为它一旦漂移，碰撞盒就会把史莱姆的上半身漏在外面——而那种错误在
 * 截图里看不出来。
 */

/**
 * 身体中心停在髋点上方 `radius * 这个比例` 处。
 *
 * 挑 0.55 是让软体被挤压后的下沿正好盖住髋关节：比它小腿会从身体里穿出来，
 * 比它大身体就浮在腿上面。
 */
export const LEGGED_SLIME_BODY_RISE_RATIO = 0.55;

/** 软体身体中心离地高度。 */
export function leggedSlimeBodyCenterY(hipHeight, radius) {
  return hipHeight + radius * LEGGED_SLIME_BODY_RISE_RATIO;
}

/**
 * 身体顶部离地高度，也就是碰撞圆柱要包到的高度。
 *
 * 多留一个 radius 而不是软体挤压后的半高：软体每帧都在呼吸，碰撞盒不该跟着变。
 */
export function leggedSlimeTopY(hipHeight, radius) {
  return leggedSlimeBodyCenterY(hipHeight, radius) + radius;
}
