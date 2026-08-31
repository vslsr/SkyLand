/**
 * 滚动草地视野的纯几何计算。
 *
 * 这里藏着整个滚动方案唯一会静默出错的地方：同一块地无论玩家站在哪里，
 * 都必须算出**逐位相同**的格坐标。着色器按格坐标哈希出草的位置、朝向和高矮，
 * 哈希会把最末一位的差异放大成完全不同的结果——草就会随着镜头闪烁。
 *
 * 所以视野原点用**整数格下标**表达，而不是已经乘过格边长的世界坐标：
 * `cellIndex = originCell + aCell` 全程是整数加法，f32 在 2²⁴ 以内精确，
 * 而 `origin + aCell * cellSize` 这种浮点累加做不到这一点。
 *
 * 这几个函数不依赖 Three.js，可以直接单测。
 */

/**
 * 视野原点所在的整数格下标：焦点减去半个视野后，向下取整到格。
 * @param focus 焦点的世界坐标（米）
 * @param span 视野跨度（米）
 * @param cellSize 单个格子的边长（米）
 */
export function alignFieldOriginCell(focus: number, span: number, cellSize: number): number {
  return Math.floor((focus - span / 2) / cellSize);
}

/**
 * 整数格下标对应的世界坐标（米）。
 * @param cellIndex 整数格下标
 * @param cellSize 单个格子的边长（米）
 */
export function cellToWorld(cellIndex: number, cellSize: number): number {
  return cellIndex * cellSize;
}

/**
 * 某个世界坐标落在哪个整数格上。
 * @param worldValue 世界坐标（米）
 * @param cellSize 单个格子的边长（米）
 */
export function worldToCell(worldValue: number, cellSize: number): number {
  return Math.floor(worldValue / cellSize);
}
