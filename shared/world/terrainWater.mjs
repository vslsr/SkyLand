/**
 * 地形水体的统一判定。
 *
 * 格子高度永远表示地面/海床；WATER 只表示该格属于已连通水域。
 * 海平面不会修改海床，也不会让所有低于它的普通地面自动积水。
 */

import { TERRAIN_SURFACE } from './terrainConfig.mjs';
import {
  terrainCellCornerHeight,
  terrainCellSurface,
} from './terrainContent.mjs';

const WATER_DEPTH_EPSILON = 1e-6;

/** 返回采样点的实际水深；普通地面即使低于海平面也保持干燥。 */
export function terrainWaterDepth(sample, seaLevel = 0) {
  if (sample.surface !== TERRAIN_SURFACE.WATER) return 0;
  return Math.max(0, Number(seaLevel) - sample.groundY);
}

export function terrainSampleHasWater(sample, seaLevel = 0) {
  return terrainWaterDepth(sample, seaLevel) > WATER_DEPTH_EPSILON;
}

/** 射线、相机与交互共用的可见表面高度。 */
export function terrainSurfaceHeight(sample, seaLevel = 0) {
  return terrainSampleHasWater(sample, seaLevel)
    ? Number(seaLevel)
    : sample.groundY;
}

export function terrainCellMinimumBedHeight(code) {
  return Math.min(
    terrainCellCornerHeight(code, 0, 0),
    terrainCellCornerHeight(code, 1, 0),
    terrainCellCornerHeight(code, 1, 1),
    terrainCellCornerHeight(code, 0, 1),
  );
}

/**
 * 当前整格水面网格是否需要生成。斜面只要有角点低于海平面就生成水面，
 * 高出水面的部分交给深度测试自然露出，允许海床继续使用斜坡形状。
 */
export function terrainCellHasWater(code, seaLevel = 0) {
  if (terrainCellSurface(code) !== TERRAIN_SURFACE.WATER) return false;
  return terrainCellMinimumBedHeight(code) < Number(seaLevel) - WATER_DEPTH_EPSILON;
}
