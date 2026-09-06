/**
 * 导航网格的全局约定。
 *
 * 这一层的形状是照着 Minecraft 的寻路抄来的，但抄的是**结构**不是数值：
 * 一个把世界格子翻译成「这一格是什么」的 NodeEvaluator（`navNodeEvaluator.mjs`）、
 * 一份只覆盖搜索窗口的世界快照（`NavRegion.mjs`）、一个带节点上限和最近点回退的
 * A*（`findNavPath.mjs`）。Minecraft 用方块坐标，SkyLand 用地形格坐标——两边都是
 * 「格子有类型、类型有代价」，所以整套结构原样成立。
 *
 * 导航格 = 地形格 = 建造格。三套网格共用一个尺寸不是巧合：地形格是地面的最小
 * 起伏单位，建造格是地基的最小占位单位，寻路要看的正是这两件事。用第三个尺寸
 * 会让「这一格能不能站人」这个问题在三套坐标之间反复换算，而每一次换算都是
 * 一次可能的分歧。
 */

import { TERRAIN_CELL_SIZE } from '../world/terrainConfig.mjs';

export const NAV_CELL_SIZE = TERRAIN_CELL_SIZE;

/**
 * 一格的导航类型。数值只在进程内用（不进快照、不上网络），但顺序仍然固定，
 * 因为默认代价表 `DEFAULT_NAV_MALUS` 是按下标写的。
 *
 * 对照 Minecraft 的 `PathType`：BLOCKED / WALKABLE / WATER / DAMAGE_FIRE 一一对应，
 * SLOPE 与 DECK 是 SkyLand 独有的——这个世界的地面是有坡度的台阶地形，而玩家
 * 会自己往上面铺地基。
 */
export const NAV_NODE = Object.freeze({
  /** 走不通：出界、被实心碰撞体占住、落差太大。 */
  BLOCKED: 0,
  /** 普通平地。 */
  WALKABLE: 1,
  /** 斜坡或角点格：走得上去，但走起来慢一点。 */
  SLOPE: 2,
  /** 玩家铺的地基顶面。踩上去和平地一样稳，所以代价与平地相同。 */
  DECK: 3,
  /** 紧挨着水的陆地格。陆生 AI 宁可绕开，免得贴着岸走时被水推下去。 */
  WATER_EDGE: 4,
  /** 水面。会游的才走得了，不会游的就是一堵墙。 */
  WATER: 5,
  /** 危险物件（篝火之类）所在的格。绕得开就绕。 */
  DANGER: 6,
});

export const NAV_NODE_COUNT = 7;

/**
 * 默认代价加成。`-1` 表示「走不了」，与 Minecraft 的 malus 约定一致：
 * 单位可以把某一项调成非负数来解锁它（会游的把 WATER 调成 4），
 * 也可以调高让它更不情愿走（怕火的把 DANGER 调到 16）。
 *
 * 数值是**乘在这一步的距离上的额外倍数**，不是加法常数：换成加法的话，
 * 同样一格的惩罚在长路径上会被稀释，而「宁可多绕两米也不下水」正是要
 * 按距离比价的。
 */
export const DEFAULT_NAV_MALUS = Object.freeze([
  -1,   // BLOCKED
  0,    // WALKABLE
  0.5,  // SLOPE
  0,    // DECK
  1.5,  // WATER_EDGE
  -1,   // WATER
  8,    // DANGER
]);

/** 代价表里可以写的最大值。再大就该直接写 -1 说「不走」，而不是写一个天文数字。 */
export const MAX_NAV_MALUS = 64;

/**
 * 搜索窗口的半径上限，单位是格。
 *
 * 这是大世界最重要的一条闸：`NavRegion` 会为窗口里的每一格预留常数字节，
 * 内存因此是 O(半径²) 而不是 O(世界面积)。48 格 = 96 米见方的窗口，约 2.3 万格，
 * 已经比任何一只生物该关心的范围都大。
 */
export const MAX_NAV_SEARCH_RADIUS_CELLS = 48;
export const DEFAULT_NAV_SEARCH_RADIUS_CELLS = 20;

/**
 * 一次搜索最多展开多少个节点。A* 在死路里会把整个窗口翻一遍，这条上限保证
 * 「找不到路」的最坏情况和「一步就到」的最好情况耗时在同一个量级。
 * Minecraft 有同名的 `maxVisitedNodes`，理由一模一样。
 */
export const MAX_NAV_VISITED_NODES = 1024;
export const DEFAULT_NAV_VISITED_NODES = 320;

/** 一条路径最多留多少个节点。超出的部分会被截断——走完之后自然会再寻一次。 */
export const MAX_NAV_PATH_NODES = 96;

/** 世界坐标 → 导航格坐标。负坐标必须向下取整，否则 0 附近会有一格宽的错位。 */
export function toNavCell(worldCoordinate) {
  return Math.floor(worldCoordinate / NAV_CELL_SIZE);
}

/** 导航格坐标 → 该格中心的世界坐标。路径节点一律落在格心。 */
export function navCellCenter(cell) {
  return (cell + 0.5) * NAV_CELL_SIZE;
}

/** 把类型下标解析成代价加成；越界的下标当作走不通，而不是当作免费。 */
export function navMalusOf(malus, type) {
  const table = malus ?? DEFAULT_NAV_MALUS;
  return type >= 0 && type < NAV_NODE_COUNT ? table[type] : -1;
}

/** 这个类型这个单位走不走得了。 */
export function isNavTypePassable(malus, type) {
  return navMalusOf(malus, type) >= 0;
}
