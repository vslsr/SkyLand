/**
 * 流式台阶地形的全局尺寸约定。
 *
 * 这些值同时影响客户端网格、服务端地面采样与 Rust/WASM 里的物件落点，
 * 改动时必须同步 native/chunkgen/src/terrain.rs。
 */

import { CHUNK_SIZE, CHUNK_SIZE_MM } from './worldConfig.mjs';

/** 一个可编辑地形格的边长。与当前纸绘地面网格的 2 米间距一致。 */
export const TERRAIN_CELL_SIZE = 2;
export const TERRAIN_CELL_SIZE_MM = TERRAIN_CELL_SIZE * 1000;

/** 每个 chunk 固定 16×16 格；内存和构建成本只与活动 chunk 数量有关。 */
export const TERRAIN_GRID = CHUNK_SIZE / TERRAIN_CELL_SIZE;
export const TERRAIN_CELL_COUNT = TERRAIN_GRID * TERRAIN_GRID;

/** 相邻台地的一层高度。2 米水平跨度对应约 26.6° 的斜坡。 */
export const TERRAIN_HEIGHT_STEP = 1;
export const TERRAIN_HEIGHT_STEP_MM = TERRAIN_HEIGHT_STEP * 1000;

if (!Number.isInteger(TERRAIN_GRID) || CHUNK_SIZE_MM % TERRAIN_CELL_SIZE_MM !== 0) {
  throw new Error('地形格尺寸必须整除 chunk 尺寸');
}

export const TERRAIN_SURFACE = Object.freeze({
  GROUND: 0,
  WATER: 1,
});

/**
 * 方向表示斜坡的高边或角点；NORTH 对应世界 +Z，EAST 对应世界 +X。
 * CORNER_HIGH_* 只有命名角点在高层，CORNER_LOW_* 只有命名角点在低层。
 */
export const TERRAIN_SHAPE = Object.freeze({
  FLAT: 0,
  RAMP_NORTH: 1,
  RAMP_EAST: 2,
  RAMP_SOUTH: 3,
  RAMP_WEST: 4,
  CORNER_HIGH_NORTH_EAST: 5,
  CORNER_HIGH_SOUTH_EAST: 6,
  CORNER_HIGH_SOUTH_WEST: 7,
  CORNER_HIGH_NORTH_WEST: 8,
  CORNER_LOW_NORTH_EAST: 9,
  CORNER_LOW_SOUTH_EAST: 10,
  CORNER_LOW_SOUTH_WEST: 11,
  CORNER_LOW_NORTH_WEST: 12,
});

/** code 低四位保存形状，第 4 位保存表面类型，高字节保存有符号高度层。 */
export const TERRAIN_SHAPE_MASK = 0b1111;
export const TERRAIN_SURFACE_SHIFT = 4;
export const TERRAIN_HEIGHT_SHIFT = 8;
