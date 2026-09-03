/**
 * 大世界与 chunk 的尺寸约定。
 *
 * 这里的常量同时决定「世界长什么样」和「同步/加载的粒度」，
 * 所以必须由浏览器与房间进程共同引用，两端不能各写一份。
 *
 * 单位约定：对外的米使用浮点，内部放置算法一律走毫米整数，
 * 这样 JS 参考实现与 WASM 实现能得到逐位相同的结果。
 */

/** 单个 chunk 的边长（米）。 */
export const CHUNK_SIZE = 32;

/** 单个 chunk 的边长（毫米），放置算法的整数域尺度。 */
export const CHUNK_SIZE_MM = CHUNK_SIZE * 1000;

/**
 * 世界在每个轴向上的 chunk 数量的一半。
 *
 * 世界不再是一张有边的地图：chunk 完全由种子确定性生成，加载集合只跟着玩家
 * 走，所以「世界多大」不是玩法设计，而是**数值精度的预算**。这里的取值来自
 * 三条硬约束里最紧的一条：
 *
 * - 放置算法在毫米整数域上跑，坐标要留在 int32 内（WASM 侧是 i32）：
 *   |chunk| < 2³¹ / CHUNK_SIZE_MM ≈ 67000；
 * - chunk 的填充与轮廓顶点是**世界坐标**的 float32 属性，网格线、雾与云影也
 *   按世界坐标采样：32 km 处 float32 的分辨率约 4 毫米，130 km 处降到 1.6 厘米，
 *   线稿会开始抖；
 * - Rapier 是 f32 物理，角色控制器的容差同样吃这份分辨率。
 *
 * 1024 是三者都还宽裕的那一档：世界 65 × 65 公里，直线跑到边界要一个多小时，
 * 玩家实际上碰不到它。要再往外走，需要的不是调大这个数，而是把几何体改成
 * chunk 局部坐标 + 浮动原点（远处的一切都相对玩家所在 chunk 表达）。
 *
 * chunk 坐标的合法范围是 [-WORLD_CHUNK_RADIUS, WORLD_CHUNK_RADIUS - 1]。
 */
export const WORLD_CHUNK_RADIUS = 1024;

/** chunk 坐标的合法区间（闭区间）。 */
export const MINIMUM_CHUNK_COORDINATE = -WORLD_CHUNK_RADIUS;
export const MAXIMUM_CHUNK_COORDINATE = WORLD_CHUNK_RADIUS - 1;

/**
 * 玩家活动区比生成范围向内缩的 chunk 数。
 *
 * 留出这一圈的意义：玩家永远走不到未生成的世界边缘旁边，
 * 视野尽头始终是有内容的地面，而不是虚空。这一圈是精度上限的护栏，
 * 不是玩法边界——它离出生点 32 公里，正常游玩到不了。
 */
export const PLAY_AREA_CHUNK_MARGIN = 2;

/** 玩家活动范围（米），由世界尺寸减去边缘缓冲得到。 */
export const WORLD_PLAY_AREA_HALF_SIZE =
  (WORLD_CHUNK_RADIUS - PLAY_AREA_CHUNK_MARGIN) * CHUNK_SIZE;

/** @type {{ minimumX: number, maximumX: number, minimumZ: number, maximumZ: number }} */
export const WORLD_PLAY_AREA = {
  minimumX: -WORLD_PLAY_AREA_HALF_SIZE,
  maximumX: WORLD_PLAY_AREA_HALF_SIZE,
  minimumZ: -WORLD_PLAY_AREA_HALF_SIZE,
  maximumZ: WORLD_PLAY_AREA_HALF_SIZE,
};

/**
 * 以焦点所在 chunk 为中心，向外加载这么多圈。
 * 半径 2 时最近的未加载内容至少在 2 × CHUNK_SIZE = 64 米外，
 * 大于雾效的远端距离，chunk 的出现与消失都被雾盖住。
 */
export const CHUNK_LOAD_RADIUS = 2;

/**
 * 超过这个半径才卸载。必须严格大于 CHUNK_LOAD_RADIUS：
 * 两个半径相等时，站在 chunk 边界上来回走会不停地建了拆、拆了建。
 */
export const CHUNK_KEEP_RADIUS = 3;

/** 每帧最多构建的 chunk 数，避免快速移动时一次性建一堆造成掉帧。 */
export const CHUNK_BUILD_BUDGET_PER_FRAME = 1;

/** 每个 chunk 在每个轴向上划分的放置格数，共 PROP_GRID² 个候选点。 */
export const PROP_GRID = 8;

/** 单个放置格的边长（毫米）。 */
export const PROP_CELL_SIZE_MM = CHUNK_SIZE_MM / PROP_GRID;

/** 单个 chunk 的物件数量上限，与 WASM 侧的静态缓冲区容量一致。 */
export const MAXIMUM_PROPS_PER_CHUNK = PROP_GRID * PROP_GRID;

/** 物件种类。数值会写进 WASM 的放置记录，不能随意重排。 */
export const PROP_KIND = {
  TREE: 0,
  GRASS: 1,
  ROCK: 2,
  MUSHROOM: 3,
};

/** 物件种类总数，模板注册与遍历都按它来。 */
export const PROP_KIND_COUNT = 4;

/** 房间没有指定种子时使用的默认世界种子。 */
export const DEFAULT_WORLD_SEED = 0x5c1a2d0b;

/**
 * chunk 坐标是否落在世界内。
 * @param {number} chunkX
 * @param {number} chunkZ
 * @returns {boolean}
 */
export function isChunkInsideWorld(chunkX, chunkZ) {
  return (
    chunkX >= MINIMUM_CHUNK_COORDINATE &&
    chunkX <= MAXIMUM_CHUNK_COORDINATE &&
    chunkZ >= MINIMUM_CHUNK_COORDINATE &&
    chunkZ <= MAXIMUM_CHUNK_COORDINATE
  );
}

/**
 * 把任意数值收敛成一个合法的 32 位无符号世界种子。
 * @param {unknown} value
 * @returns {number}
 */
export function toWorldSeed(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_WORLD_SEED;
  return Math.floor(numeric) >>> 0;
}
