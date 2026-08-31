/**
 * 全场共享的纸张底色与雾效距离。
 *
 * 底色同时用于场景背景、渲染器清屏色和填充着色器里的雾色，三者必须一致，
 * 否则远处会浮出一层色差。雾效距离还和 chunk 的加载半径绑在一起：
 * FOG_FAR 必须小于 CHUNK_LOAD_RADIUS × CHUNK_SIZE，
 * 这样视野尽头永远是雾，而不是一条突然出现的 chunk 边界。
 * tests/atmosphere.test.ts 守着这条约束。
 */

export const PAPER_COLOR = 0xfdfbf6;

export const FOG_NEAR = 22;
export const FOG_FAR = 52;
