/**
 * 大世界稀疏地形编辑门面。
 *
 * 所有操作只写 TerrainPatchStore，未编辑区域继续由种子即时生成。单格编辑因此
 * 是 O(1)，内存只随实际改动格数增长，chunk 的重建通知也由 patch 层局部派发。
 */

import {
  TERRAIN_CELL_SIZE,
  TERRAIN_SHAPE,
  TERRAIN_SURFACE,
} from './terrainConfig.mjs';
import {
  encodeTerrainCell,
  sampleTerrain,
  terrainCellHeightLevel,
  terrainCellShape,
  terrainCellSurface,
} from './terrainContent.mjs';
import { TerrainPatchStore } from './terrainPatches.mjs';
import {
  terrainCellHasWater,
  terrainCellMinimumBedHeight,
  terrainWaterDepth,
} from './terrainWater.mjs';

const MINIMUM_HEIGHT_LEVEL = -128;
const MAXIMUM_HEIGHT_LEVEL = 127;
const CARDINAL_NEIGHBORS = Object.freeze([
  Object.freeze([0, 1]),
  Object.freeze([1, 0]),
  Object.freeze([0, -1]),
  Object.freeze([-1, 0]),
]);

export const TERRAIN_RAMP_DIRECTION = Object.freeze({
  NORTH: 'north',
  EAST: 'east',
  SOUTH: 'south',
  WEST: 'west',
});

const RAMP_SHAPE_BY_DIRECTION = Object.freeze({
  [TERRAIN_RAMP_DIRECTION.NORTH]: TERRAIN_SHAPE.RAMP_NORTH,
  [TERRAIN_RAMP_DIRECTION.EAST]: TERRAIN_SHAPE.RAMP_EAST,
  [TERRAIN_RAMP_DIRECTION.SOUTH]: TERRAIN_SHAPE.RAMP_SOUTH,
  [TERRAIN_RAMP_DIRECTION.WEST]: TERRAIN_SHAPE.RAMP_WEST,
});

function requireInteger(value, name) {
  if (!Number.isInteger(value)) throw new TypeError(`${name} 必须是整数`);
  return value;
}

function requireHeightLevel(value) {
  const level = requireInteger(value, '地形高度层');
  if (level < MINIMUM_HEIGHT_LEVEL || level > MAXIMUM_HEIGHT_LEVEL) {
    throw new RangeError(`地形高度层必须位于 ${MINIMUM_HEIGHT_LEVEL}..${MAXIMUM_HEIGHT_LEVEL}`);
  }
  return level;
}

function requireSurface(surface) {
  if (surface !== TERRAIN_SURFACE.GROUND && surface !== TERRAIN_SURFACE.WATER) {
    throw new RangeError(`未知地形类型 ${surface}`);
  }
  return surface;
}

function requireShape(shape) {
  if (
    !Number.isInteger(shape)
    || shape < TERRAIN_SHAPE.FLAT
    || shape > TERRAIN_SHAPE.CORNER_LOW_NORTH_WEST
  ) throw new RangeError(`未知地形形状 ${shape}`);
  return shape;
}

export class TerrainEditor {
  constructor(patches, options = {}) {
    if (!(patches instanceof TerrainPatchStore)) {
      throw new TypeError('TerrainEditor 需要 TerrainPatchStore');
    }
    this.patches = patches;
    this.seaLevel = Number.isFinite(Number(options.seaLevel))
      ? Number(options.seaLevel)
      : 0;
    this.cellCodeAt = (globalCellX, globalCellZ) => (
      this.patches.cellCodeAt(globalCellX, globalCellZ)
    );
  }

  /** 返回编辑器可直接展示的单格状态，包括独立海床高度与实际水深。 */
  readCell(globalCellX, globalCellZ) {
    requireInteger(globalCellX, 'globalCellX');
    requireInteger(globalCellZ, 'globalCellZ');
    const code = this.patches.cellCodeAt(globalCellX, globalCellZ);
    const sample = sampleTerrain(
      this.patches.worldSeed,
      (globalCellX + 0.5) * TERRAIN_CELL_SIZE,
      (globalCellZ + 0.5) * TERRAIN_CELL_SIZE,
      {},
      this.cellCodeAt,
    );
    return {
      globalCellX,
      globalCellZ,
      code,
      heightLevel: terrainCellHeightLevel(code),
      surface: terrainCellSurface(code),
      shape: terrainCellShape(code),
      bedY: sample.groundY,
      waterDepth: terrainWaterDepth(sample, this.seaLevel),
      patched: this.patches.hasCell(globalCellX, globalCellZ),
    };
  }

  /**
   * 原子修改一格；未显式指定 surface 时保留原类型。若降低后的普通地面低于
   * 海平面并紧邻真实水格，则按四邻域让水进入；远处孤立深坑不会自动积水。
   */
  setCell(globalCellX, globalCellZ, changes = {}) {
    requireInteger(globalCellX, 'globalCellX');
    requireInteger(globalCellZ, 'globalCellZ');
    const previous = this.patches.cellCodeAt(globalCellX, globalCellZ);
    const previousHeight = terrainCellHeightLevel(previous);
    const heightLevel = changes.heightLevel === undefined
      ? previousHeight
      : requireHeightLevel(changes.heightLevel);
    const shape = changes.shape === undefined
      ? terrainCellShape(previous)
      : requireShape(changes.shape);
    const hasExplicitSurface = changes.surface !== undefined;
    let surface = hasExplicitSurface
      ? requireSurface(changes.surface)
      : terrainCellSurface(previous);

    if (
      !hasExplicitSurface
      && surface === TERRAIN_SURFACE.GROUND
      && heightLevel < previousHeight
    ) {
      const candidate = encodeTerrainCell(heightLevel, surface, shape);
      if (
        terrainCellMinimumBedHeight(candidate) < this.seaLevel
        && this.#hasAdjacentWater(globalCellX, globalCellZ)
      ) {
        surface = TERRAIN_SURFACE.WATER;
      }
    }

    // WATER 表示当前格确实承载水面，而不是不可逆的生成来源标签。抬高海床后
    // 若整格已露出海面，必须同步恢复为普通地面；否则移动系统仍会对高台启用
    // 浮力支持，把角色 Y 锁在水面高度并强制标记 grounded。
    if (
      !hasExplicitSurface
      && surface === TERRAIN_SURFACE.WATER
      && heightLevel > previousHeight
      && !terrainCellHasWater(encodeTerrainCell(heightLevel, surface, shape), this.seaLevel)
    ) {
      surface = TERRAIN_SURFACE.GROUND;
    }

    return this.patches.setCellCode(
      globalCellX,
      globalCellZ,
      encodeTerrainCell(heightLevel, surface, shape),
    );
  }

  setHeightLevel(globalCellX, globalCellZ, heightLevel) {
    return this.setCell(globalCellX, globalCellZ, { heightLevel });
  }

  raise(globalCellX, globalCellZ, steps = 1) {
    requireInteger(globalCellX, 'globalCellX');
    requireInteger(globalCellZ, 'globalCellZ');
    const amount = requireInteger(steps, '抬高层数');
    if (amount < 0) throw new RangeError('抬高层数不能为负数');
    const current = terrainCellHeightLevel(this.patches.cellCodeAt(globalCellX, globalCellZ));
    return this.setHeightLevel(globalCellX, globalCellZ, Math.min(MAXIMUM_HEIGHT_LEVEL, current + amount));
  }

  lower(globalCellX, globalCellZ, steps = 1) {
    requireInteger(globalCellX, 'globalCellX');
    requireInteger(globalCellZ, 'globalCellZ');
    const amount = requireInteger(steps, '下挖层数');
    if (amount < 0) throw new RangeError('下挖层数不能为负数');
    const current = terrainCellHeightLevel(this.patches.cellCodeAt(globalCellX, globalCellZ));
    return this.setHeightLevel(globalCellX, globalCellZ, Math.max(MINIMUM_HEIGHT_LEVEL, current - amount));
  }

  setSurface(globalCellX, globalCellZ, surface) {
    return this.setCell(globalCellX, globalCellZ, { surface });
  }

  /**
   * 显式注水必须形成真实水深。只切换 WATER 标志而保留海平面以上的地面，
   * 会得到一格变暗的“干河床”且不会生成水面；这里原子地降到最近可见水层。
   */
  flood(globalCellX, globalCellZ) {
    requireInteger(globalCellX, 'globalCellX');
    requireInteger(globalCellZ, 'globalCellZ');
    const previous = this.patches.cellCodeAt(globalCellX, globalCellZ);
    const shape = terrainCellShape(previous);
    let heightLevel = terrainCellHeightLevel(previous);
    let code = encodeTerrainCell(heightLevel, TERRAIN_SURFACE.WATER, shape);
    while (
      !terrainCellHasWater(code, this.seaLevel)
      && heightLevel > MINIMUM_HEIGHT_LEVEL
    ) {
      heightLevel -= 1;
      code = encodeTerrainCell(heightLevel, TERRAIN_SURFACE.WATER, shape);
    }
    return this.patches.setCellCode(globalCellX, globalCellZ, code);
  }

  setShape(globalCellX, globalCellZ, shape) {
    return this.setCell(globalCellX, globalCellZ, { shape });
  }

  setRamp(globalCellX, globalCellZ, direction) {
    const shape = RAMP_SHAPE_BY_DIRECTION[direction];
    if (shape === undefined) throw new RangeError(`未知斜坡方向 ${direction}`);
    return this.setShape(globalCellX, globalCellZ, shape);
  }

  flatten(globalCellX, globalCellZ) {
    return this.setShape(globalCellX, globalCellZ, TERRAIN_SHAPE.FLAT);
  }

  reset(globalCellX, globalCellZ) {
    return this.patches.resetCell(globalCellX, globalCellZ);
  }

  #hasAdjacentWater(globalCellX, globalCellZ) {
    return CARDINAL_NEIGHBORS.some(([deltaX, deltaZ]) => (
      terrainCellHasWater(
        this.patches.cellCodeAt(globalCellX + deltaX, globalCellZ + deltaZ),
        this.seaLevel,
      )
    ));
  }
}
