/**
 * 树上果子实例通道的字段布局（`RenderInstanceBuffer` 的另一种记录形状）。
 *
 * 果子和掉落堆是两条通道而不是一条，因为它们的记录内容根本不同：果子没有原型、
 * 没有驻留态、没有滚动姿态；它需要的是「这棵树在哪、多大、结几个」，
 * 具体挂在哪几个枝头由渲染侧按同一份 `selectFruitDropAnchors` 推出来
 * ——那份规则本来就是两端共用的（服务端掉落也照它抛）。
 *
 * 全是连续量，所以离散段长度为 0。
 */

export const FRUIT_INT_STRIDE = 0;
export const FRUIT_FLOAT_STRIDE = 6;

export const FRUIT_X = 0;
export const FRUIT_Y = 1;
export const FRUIT_Z = 2;
/** 树的朝向：锚点角度是相对树本身的，转树就转果子。 */
export const FRUIT_YAW = 3;
/** 树的缩放；果子的大小和挂点半径都按它缩。 */
export const FRUIT_SCALE = 4;
/** 这棵树结几个。渲染侧据此选锚点。 */
export const FRUIT_COUNT = 5;
