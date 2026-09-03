/**
 * 确定性台阶地形。
 *
 * 地形与静态物件一样，是 (worldSeed, globalCellX, globalCellZ) 的纯函数。
 * 一格的高度层、表面、群系与形状压在同一个整数 code 里；群系本身由
 * terrainBiome.mjs 算出。浏览器和房间 DS 共用本文件；Rust/WASM 在
 * native/chunkgen/src/terrain.rs 镜像同一算法，用于给合批物件写入完全一致的 Y，
 * 并让 terrainParity.test.mjs 能逐格比对整个 code。
 */

import { hash32, valueNoise } from './hash.mjs';
import { terrainBiomeAt } from './terrainBiome.mjs';
import {
  TERRAIN_BIOME,
  TERRAIN_BIOME_MASK,
  TERRAIN_BIOME_SHIFT,
  TERRAIN_CELL_COUNT,
  TERRAIN_CELL_SIZE,
  TERRAIN_CELL_SIZE_MM,
  TERRAIN_GRID,
  TERRAIN_HEIGHT_SHIFT,
  TERRAIN_HEIGHT_STEP,
  TERRAIN_SHAPE,
  TERRAIN_SHAPE_MASK,
  TERRAIN_SURFACE,
  TERRAIN_SURFACE_SHIFT,
} from './terrainConfig.mjs';

const TERRAIN_NOISE_SALT = 0x74c3_19ad;
const TERRAIN_SLOPE_SALT = 0x2b91_6e47;
/** 2^5 个 2 米格为一个噪声特征跨度，即约 64 米。 */
const TERRAIN_NOISE_SHIFT = 5;
/** 出生圆周及其附近始终保留一块 22×22 米的平坦陆地。 */
const SPAWN_SAFE_RADIUS_CELLS = 5;
const TERRAIN_CARDINAL_NEIGHBORS = [
  [0, 1, TERRAIN_SHAPE.RAMP_NORTH],
  [1, 0, TERRAIN_SHAPE.RAMP_EAST],
  [0, -1, TERRAIN_SHAPE.RAMP_SOUTH],
  [-1, 0, TERRAIN_SHAPE.RAMP_WEST],
];
const TERRAIN_LOW_CORNER_SHAPES = [
  TERRAIN_SHAPE.CORNER_LOW_SOUTH_WEST,
  TERRAIN_SHAPE.CORNER_LOW_NORTH_WEST,
  TERRAIN_SHAPE.CORNER_LOW_NORTH_EAST,
  TERRAIN_SHAPE.CORNER_LOW_SOUTH_EAST,
];
const TERRAIN_DIAGONAL_NEIGHBORS = [
  [1, 1, TERRAIN_SHAPE.CORNER_HIGH_NORTH_EAST],
  [1, -1, TERRAIN_SHAPE.CORNER_HIGH_SOUTH_EAST],
  [-1, -1, TERRAIN_SHAPE.CORNER_HIGH_SOUTH_WEST],
  [-1, 1, TERRAIN_SHAPE.CORNER_HIGH_NORTH_WEST],
];

/**
 * 把高度、表面、群系和形状压成一个整数。高度限定在 int8 足以覆盖当前 ±2 层生成器，
 * 同时给之后的稀疏编辑保留 -128..127 层。
 *
 * 群系默认草原：手写 code 的旧调用方（测试、编辑器）不必关心这一位，
 * 而生成与编辑路径一律显式传入，抬高一格雪地不会把它变回草地。
 */
export function encodeTerrainCell(heightLevel, surface, shape, biome = TERRAIN_BIOME.GRASSLAND) {
  const safeHeight = Math.max(-128, Math.min(127, Math.trunc(heightLevel)));
  return ((safeHeight & 0xff) << TERRAIN_HEIGHT_SHIFT)
    | ((biome & TERRAIN_BIOME_MASK) << TERRAIN_BIOME_SHIFT)
    | ((surface & 1) << TERRAIN_SURFACE_SHIFT)
    | (shape & TERRAIN_SHAPE_MASK);
}

export function terrainCellHeightLevel(code) {
  return ((code >>> TERRAIN_HEIGHT_SHIFT) << 24) >> 24;
}

export function terrainCellSurface(code) {
  return (code >>> TERRAIN_SURFACE_SHIFT) & 1;
}

export function terrainCellBiome(code) {
  return (code >>> TERRAIN_BIOME_SHIFT) & TERRAIN_BIOME_MASK;
}

export function terrainCellShape(code) {
  return code & TERRAIN_SHAPE_MASK;
}

/**
 * 未插坡之前的台地高度。整数阈值把连续低频噪声切成大片平台。
 * 负层明确标记为水底，0 及以上为普通地面。
 */
export function terrainBaseLevelAt(worldSeed, globalCellX, globalCellZ) {
  if (
    Math.abs(globalCellX) <= SPAWN_SAFE_RADIUS_CELLS
    && Math.abs(globalCellZ) <= SPAWN_SAFE_RADIUS_CELLS
  ) return 0;

  const noise = valueNoise(
    worldSeed ^ TERRAIN_NOISE_SALT,
    globalCellX,
    globalCellZ,
    TERRAIN_NOISE_SHIFT,
  );
  if (noise < 28) return -2;
  if (noise < 72) return -1;
  if (noise < 166) return 0;
  if (noise < 220) return 1;
  return 2;
}

/**
 * 返回一个格子的紧凑编码。低平台遇到恰好高一层的陆地邻居时成为斜坡：
 * 两个相邻正交邻居较高时生成单低角，只有对角邻居较高时生成单高角。
 * 多个方向都可连接时用稳定哈希轮换优先级，避免所有转角都偏向同一方向。
 */
export function terrainCellCodeAt(worldSeed, globalCellX, globalCellZ) {
  const heightLevel = terrainBaseLevelAt(worldSeed, globalCellX, globalCellZ);
  // 群系与高度互不干涉：水底也带着它所在片区的地皮，抽干之后露出的是同一片地。
  const biome = terrainBiomeAt(worldSeed, globalCellX, globalCellZ);
  if (heightLevel < 0) {
    return encodeTerrainCell(heightLevel, TERRAIN_SURFACE.WATER, TERRAIN_SHAPE.FLAT, biome);
  }

  const first = hash32(worldSeed, globalCellX, globalCellZ, TERRAIN_SLOPE_SALT) & 3;
  let higherCardinalMask = 0;
  for (let direction = 0; direction < TERRAIN_CARDINAL_NEIGHBORS.length; direction += 1) {
    const [deltaX, deltaZ] = TERRAIN_CARDINAL_NEIGHBORS[direction];
    if (
      terrainBaseLevelAt(worldSeed, globalCellX + deltaX, globalCellZ + deltaZ)
      === heightLevel + 1
    ) higherCardinalMask |= 1 << direction;
  }

  // 两条相邻高边合并为一个内角，避免同一角落随机退化成一条直坡。
  for (let offset = 0; offset < TERRAIN_CARDINAL_NEIGHBORS.length; offset += 1) {
    const direction = (first + offset) & 3;
    const nextDirection = (direction + 1) & 3;
    if (
      (higherCardinalMask & (1 << direction)) !== 0
      && (higherCardinalMask & (1 << nextDirection)) !== 0
    ) {
      return encodeTerrainCell(
        heightLevel,
        TERRAIN_SURFACE.GROUND,
        TERRAIN_LOW_CORNER_SHAPES[direction],
        biome,
      );
    }
  }

  for (let offset = 0; offset < TERRAIN_CARDINAL_NEIGHBORS.length; offset += 1) {
    const direction = (first + offset) & 3;
    if ((higherCardinalMask & (1 << direction)) !== 0) {
      const shape = TERRAIN_CARDINAL_NEIGHBORS[direction][2];
      return encodeTerrainCell(heightLevel, TERRAIN_SURFACE.GROUND, shape, biome);
    }
  }

  // 没有高边、只有对角高台时，用单高角把四格交点补齐。
  for (let offset = 0; offset < TERRAIN_DIAGONAL_NEIGHBORS.length; offset += 1) {
    const [deltaX, deltaZ, shape] = TERRAIN_DIAGONAL_NEIGHBORS[(first + offset) & 3];
    if (
      terrainBaseLevelAt(worldSeed, globalCellX + deltaX, globalCellZ + deltaZ)
      === heightLevel + 1
    ) {
      return encodeTerrainCell(heightLevel, TERRAIN_SURFACE.GROUND, shape, biome);
    }
  }
  return encodeTerrainCell(heightLevel, TERRAIN_SURFACE.GROUND, TERRAIN_SHAPE.FLAT, biome);
}

/** 世界毫米坐标对应的格子编码。负坐标必须向下取整。 */
export function terrainCellCodeAtMillimeters(worldSeed, xMm, zMm) {
  return terrainCellCodeAt(
    worldSeed,
    Math.floor(xMm / TERRAIN_CELL_SIZE_MM),
    Math.floor(zMm / TERRAIN_CELL_SIZE_MM),
  );
}

/**
 * 返回指定角点高度。cornerX/cornerZ 为 0 或 1，结果单位是米。
 */
export function terrainCellCornerHeight(code, cornerX, cornerZ) {
  const base = terrainCellHeightLevel(code) * TERRAIN_HEIGHT_STEP;
  switch (terrainCellShape(code)) {
    case TERRAIN_SHAPE.RAMP_NORTH:
      return base + cornerZ * TERRAIN_HEIGHT_STEP;
    case TERRAIN_SHAPE.RAMP_EAST:
      return base + cornerX * TERRAIN_HEIGHT_STEP;
    case TERRAIN_SHAPE.RAMP_SOUTH:
      return base + (1 - cornerZ) * TERRAIN_HEIGHT_STEP;
    case TERRAIN_SHAPE.RAMP_WEST:
      return base + (1 - cornerX) * TERRAIN_HEIGHT_STEP;
    case TERRAIN_SHAPE.CORNER_HIGH_NORTH_EAST:
      return base + Math.min(cornerX, cornerZ) * TERRAIN_HEIGHT_STEP;
    case TERRAIN_SHAPE.CORNER_HIGH_SOUTH_EAST:
      return base + Math.min(cornerX, 1 - cornerZ) * TERRAIN_HEIGHT_STEP;
    case TERRAIN_SHAPE.CORNER_HIGH_SOUTH_WEST:
      return base + Math.min(1 - cornerX, 1 - cornerZ) * TERRAIN_HEIGHT_STEP;
    case TERRAIN_SHAPE.CORNER_HIGH_NORTH_WEST:
      return base + Math.min(1 - cornerX, cornerZ) * TERRAIN_HEIGHT_STEP;
    case TERRAIN_SHAPE.CORNER_LOW_NORTH_EAST:
      return base + (1 - Math.min(cornerX, cornerZ)) * TERRAIN_HEIGHT_STEP;
    case TERRAIN_SHAPE.CORNER_LOW_SOUTH_EAST:
      return base + (1 - Math.min(cornerX, 1 - cornerZ)) * TERRAIN_HEIGHT_STEP;
    case TERRAIN_SHAPE.CORNER_LOW_SOUTH_WEST:
      return base + (1 - Math.min(1 - cornerX, 1 - cornerZ)) * TERRAIN_HEIGHT_STEP;
    case TERRAIN_SHAPE.CORNER_LOW_NORTH_WEST:
      return base + (1 - Math.min(1 - cornerX, cornerZ)) * TERRAIN_HEIGHT_STEP;
    default:
      return base;
  }
}

/**
 * O(1) 世界表面采样。target 可复用，移动热路径不会为每个脚点产生临时对象。
 */
export function sampleTerrain(worldSeed, x, z, target = {}, cellCodeAt) {
  const globalCellX = Math.floor(x / TERRAIN_CELL_SIZE);
  const globalCellZ = Math.floor(z / TERRAIN_CELL_SIZE);
  const localX = x / TERRAIN_CELL_SIZE - globalCellX;
  const localZ = z / TERRAIN_CELL_SIZE - globalCellZ;
  const code = typeof cellCodeAt === 'function'
    ? cellCodeAt(globalCellX, globalCellZ)
    : terrainCellCodeAt(worldSeed, globalCellX, globalCellZ);
  const shape = terrainCellShape(code);
  const base = terrainCellHeightLevel(code) * TERRAIN_HEIGHT_STEP;
  let ramp = 0;
  let normalX = 0;
  let normalZ = 0;
  const slope = TERRAIN_HEIGHT_STEP / TERRAIN_CELL_SIZE;
  if (shape === TERRAIN_SHAPE.RAMP_NORTH) {
    ramp = localZ;
    normalZ = -slope;
  } else if (shape === TERRAIN_SHAPE.RAMP_EAST) {
    ramp = localX;
    normalX = -slope;
  } else if (shape === TERRAIN_SHAPE.RAMP_SOUTH) {
    ramp = 1 - localZ;
    normalZ = slope;
  } else if (shape === TERRAIN_SHAPE.RAMP_WEST) {
    ramp = 1 - localX;
    normalX = slope;
  } else if (
    shape >= TERRAIN_SHAPE.CORNER_HIGH_NORTH_EAST
    && shape <= TERRAIN_SHAPE.CORNER_LOW_NORTH_WEST
  ) {
    let cornerX = localX;
    let cornerZ = localZ;
    let derivativeX = 1;
    let derivativeZ = 1;
    if (
      shape === TERRAIN_SHAPE.CORNER_HIGH_SOUTH_EAST
      || shape === TERRAIN_SHAPE.CORNER_LOW_SOUTH_EAST
    ) {
      cornerZ = 1 - localZ;
      derivativeZ = -1;
    } else if (
      shape === TERRAIN_SHAPE.CORNER_HIGH_SOUTH_WEST
      || shape === TERRAIN_SHAPE.CORNER_LOW_SOUTH_WEST
    ) {
      cornerX = 1 - localX;
      cornerZ = 1 - localZ;
      derivativeX = -1;
      derivativeZ = -1;
    } else if (
      shape === TERRAIN_SHAPE.CORNER_HIGH_NORTH_WEST
      || shape === TERRAIN_SHAPE.CORNER_LOW_NORTH_WEST
    ) {
      cornerX = 1 - localX;
      derivativeX = -1;
    }

    const followsX = cornerX <= cornerZ;
    const lowCorner = shape >= TERRAIN_SHAPE.CORNER_LOW_NORTH_EAST;
    ramp = Math.min(cornerX, cornerZ);
    if (lowCorner) ramp = 1 - ramp;
    const derivativeSign = lowCorner ? -1 : 1;
    if (followsX) {
      normalX = -slope * derivativeX * derivativeSign;
    } else {
      normalZ = -slope * derivativeZ * derivativeSign;
    }
  }
  const inverseNormalLength = 1 / Math.hypot(normalX, 1, normalZ);
  target.x = x;
  target.z = z;
  target.globalCellX = globalCellX;
  target.globalCellZ = globalCellZ;
  target.code = code;
  target.heightLevel = terrainCellHeightLevel(code);
  target.groundY = base + ramp * TERRAIN_HEIGHT_STEP;
  target.normalX = normalX * inverseNormalLength;
  target.normalY = inverseNormalLength;
  target.normalZ = normalZ * inverseNormalLength;
  target.surface = terrainCellSurface(code);
  target.biome = terrainCellBiome(code);
  target.shape = shape;
  target.walkable = target.surface === TERRAIN_SURFACE.GROUND;
  return target;
}

/** 为单个 chunk 生成紧凑数据，供调试、测试和之后的稀疏 patch 层使用。 */
export function buildTerrainChunkData(worldSeed, chunkX, chunkZ) {
  const heights = new Int16Array(TERRAIN_CELL_COUNT);
  const meta = new Uint8Array(TERRAIN_CELL_COUNT);
  for (let localZ = 0; localZ < TERRAIN_GRID; localZ += 1) {
    for (let localX = 0; localX < TERRAIN_GRID; localX += 1) {
      const index = localZ * TERRAIN_GRID + localX;
      const code = terrainCellCodeAt(
        worldSeed,
        chunkX * TERRAIN_GRID + localX,
        chunkZ * TERRAIN_GRID + localZ,
      );
      heights[index] = terrainCellHeightLevel(code);
      meta[index] = code & 0xff;
    }
  }
  return { heights, meta };
}
