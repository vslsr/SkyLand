/**
 * chunk 内容的确定性生成。
 *
 * 这是整套大世界方案的地基：只要种子和 chunk 坐标相同，
 * 浏览器、房间进程和 WASM 必须算出完全一样的物件列表。
 * 有了这个保证，静态物件就永远不需要走网络，网络上只留活动实体和差异。
 *
 * 为此这里的算法全程在整数域上跑：坐标用毫米、角度用毫弧度、
 * 缩放用千分数，最后才由调用方统一除以 1000 换算成米与弧度。
 * 浮点只出现在这最后一步，两端的除法结果按 IEEE 754 必然相同。
 */

import { hash32, valueNoise } from './hash.mjs';
import {
  terrainCellBiome,
  terrainCellCodeAtMillimeters,
  terrainCellHeightLevel,
  terrainCellShape,
  terrainCellSurface,
} from './terrainContent.mjs';
import {
  TERRAIN_BIOME,
  TERRAIN_BIOME_COUNT,
  TERRAIN_HEIGHT_STEP_MM,
  TERRAIN_SHAPE,
  TERRAIN_SURFACE,
} from './terrainConfig.mjs';
import {
  CHUNK_SIZE_MM,
  MAXIMUM_PROPS_PER_CHUNK,
  PROP_CELL_SIZE_MM,
  PROP_GRID,
  PROP_KIND,
} from './worldConfig.mjs';

/** 一条放置记录占用的整数个数。WASM 侧使用同一个布局。 */
export const PROP_STRIDE = 6;

/** 放置记录里各字段的下标。 */
export const PROP_FIELD = {
  KIND: 0,
  X_MM: 1,
  Z_MM: 2,
  ROTATION_MRAD: 3,
  SCALE_THOUSANDTHS: 4,
  Y_MM: 5,
};

/** 放置缓冲区需要的整数长度。 */
export const PROP_BUFFER_LENGTH = MAXIMUM_PROPS_PER_CHUNK * PROP_STRIDE;

/** 物件到放置格边界的最小距离（毫米），避免物件骑在 chunk 接缝上。 */
const PROP_MARGIN_MM = 600;
const JITTER_SPAN_MM = PROP_CELL_SIZE_MM - PROP_MARGIN_MM * 2;

/** 密度噪声的尺度：格点间距 2⁴ = 16 个放置格，约 64 米一片林子。 */
const DENSITY_SHIFT = 4;

/** 各路哈希的盐，保证占位、抖动、尺寸三次取值互不相关。 */
const DENSITY_SALT = 0x1f3a5b7c;
const OCCUPANCY_SALT = 0x2c9f13a5;
const JITTER_SALT = 0x6b17d4e9;
const SIZE_SALT = 0x3ea77b21;

/** 一个放置格有物件的基础概率（0-255）。 */
const BASE_OCCUPANCY = 96;

/** 密度最高处额外增加的占用概率。 */
const OCCUPANCY_FROM_DENSITY = 48;

/** 树的占比随密度从 16/255 升到 120/255，其余按岩石、蘑菇、草分配。 */
const BASE_TREE_SHARE = 16;
const TREE_SHARE_FROM_DENSITY = 104;
const ROCK_SHARE = 32;
/** 扣掉树与岩石后，蘑菇占 3/7、草占 4/7，所以蘑菇比草稍少。 */
const MUSHROOM_PLANT_SHARE_NUMERATOR = 3;
const PLANT_SHARE_DENOMINATOR = 7;

/**
 * 每种地皮的物件风格，下标是 `TERRAIN_BIOME` 的值。
 *
 * 五个字段都是相对草原基准的千分之…不，是 255 分之几：255 表示与草原一模一样，
 * 0 表示这种地皮上根本不长。`occupancy` 缩放整格的有物件概率，其余四个缩放各类
 * 物件在剩下那次掷点里的权重。
 *
 * **草原一行全是 255 是刻意的**：这样草原上的世界与引入群系之前逐位相同，
 * 「无边草原」这张图原本长什么样，加了群系之后在草地上还是什么样。
 *
 * 数值只减不增（`occupancy` 全部 ≤ 255），所以单 chunk 物件数上限不变，
 * WASM 侧的静态缓冲区与顶点预算都不需要跟着调。
 */
const BIOME_PROP_STYLE = [
  // 草原：树随密度成林，草铺底，蘑菇零星，石头点缀。
  { occupancy: 255, tree: 255, rock: 255, mushroom: 255, grass: 255 },
  // 沙地：空旷。风蚀石为主，偶有枯树，草稀疏，不长蘑菇。
  { occupancy: 105, tree: 70, rock: 380, mushroom: 0, grass: 45 },
  // 烂泥地：潮湿。蘑菇成片，草也旺，树和石头都少。
  { occupancy: 240, tree: 70, rock: 60, mushroom: 420, grass: 200 },
  // 雪地：稀疏。针叶树留着，石头露头，草被雪压住，不长蘑菇。
  { occupancy: 135, tree: 210, rock: 260, mushroom: 0, grass: 35 },
  // 石头地：碎石遍地，草挤在石缝里，树很少，背阴处偶有蘑菇。
  { occupancy: 175, tree: 45, rock: 900, mushroom: 90, grass: 90 },
];

/** 越界地皮退回草原。生成路径只会给出 0..4，这条是给手写 code 的调用方兜底。 */
function biomePropStyle(biome) {
  return BIOME_PROP_STYLE[biome >= 0 && biome < TERRAIN_BIOME_COUNT
    ? biome
    : TERRAIN_BIOME.GRASSLAND];
}

/** 各种物件的缩放范围（千分数）。 */
const SCALE_RANGE = {
  [PROP_KIND.TREE]: { minimum: 820, maximum: 1360 },
  [PROP_KIND.GRASS]: { minimum: 780, maximum: 1250 },
  [PROP_KIND.ROCK]: { minimum: 700, maximum: 1400 },
  [PROP_KIND.MUSHROOM]: { minimum: 850, maximum: 1150 },
};

const TWO_PI_MRAD = 6283;

/**
 * 生成一个 chunk 的全部物件，写入调用方提供的整数缓冲区。
 *
 * 缓冲区复用是刻意的：流式加载每帧都可能生成 chunk，
 * 每次都新建数组会在移动过程中制造持续的 GC 压力。
 *
 * @param {number} worldSeed 32 位世界种子
 * @param {number} chunkX
 * @param {number} chunkZ
 * @param {Int32Array} target 长度至少为 PROP_BUFFER_LENGTH
 * @returns {number} 实际写入的物件数量
 */
export function generateChunkProps(worldSeed, chunkX, chunkZ, target) {
  const originX = chunkX * CHUNK_SIZE_MM;
  const originZ = chunkZ * CHUNK_SIZE_MM;
  let count = 0;

  for (let cellZ = 0; cellZ < PROP_GRID; cellZ += 1) {
    for (let cellX = 0; cellX < PROP_GRID; cellX += 1) {
      const globalCellX = chunkX * PROP_GRID + cellX;
      const globalCellZ = chunkZ * PROP_GRID + cellZ;

      // 密度噪声决定这一带是密林还是空地，同一片区域的相邻格取值接近。
      const density = valueNoise(worldSeed ^ DENSITY_SALT, globalCellX, globalCellZ, DENSITY_SHIFT);
      const occupancyHash = hash32(worldSeed, globalCellX, globalCellZ, OCCUPANCY_SALT);
      const jitterHash = hash32(worldSeed, globalCellX, globalCellZ, JITTER_SALT);

      // 先落点、再问地皮：占用率与种类都跟着脚下这一格的地皮走，所以地形必须
      // 排在掷点之前。位置本身与地皮无关，两次哈希也没变，草原上的结果不受影响。
      const xMm =
        originX + cellX * PROP_CELL_SIZE_MM + PROP_MARGIN_MM + (jitterHash % JITTER_SPAN_MM);
      const zMm =
        originZ + cellZ * PROP_CELL_SIZE_MM + PROP_MARGIN_MM + ((jitterHash >>> 12) % JITTER_SPAN_MM);
      const terrainCode = terrainCellCodeAtMillimeters(worldSeed, xMm, zMm);
      if (
        terrainCellSurface(terrainCode) !== TERRAIN_SURFACE.GROUND
        || terrainCellShape(terrainCode) !== TERRAIN_SHAPE.FLAT
      ) continue;

      const style = biomePropStyle(terrainCellBiome(terrainCode));
      const occupancy = (
        (BASE_OCCUPANCY + ((density * OCCUPANCY_FROM_DENSITY) / 255 | 0)) * style.occupancy / 255
      ) | 0;
      if ((occupancyHash & 0xff) >= occupancy) continue;

      // 四类物件的权重：树仍随密度成林，其余按地皮缩放，草拿走剩下的。
      // 权重合计在草原上恰好是 256，掷点因此与引入群系之前完全一致。
      const treeShare = (
        (BASE_TREE_SHARE + ((density * TREE_SHARE_FROM_DENSITY) / 255 | 0)) * style.tree / 255
      ) | 0;
      const rockShare = (ROCK_SHARE * style.rock / 255) | 0;
      const rockLimit = treeShare + rockShare;
      const plantShare = Math.max(0, 256 - rockLimit);
      const mushroomPlants = (
        plantShare * MUSHROOM_PLANT_SHARE_NUMERATOR / PLANT_SHARE_DENOMINATOR
      ) | 0;
      const mushroomShare = (mushroomPlants * style.mushroom / 255) | 0;
      const grassShare = ((plantShare - mushroomPlants) * style.grass / 255) | 0;
      const kindRoll = (
        ((occupancyHash >>> 8) & 0xff)
        * (rockLimit + mushroomShare + grassShare) / 256
      ) | 0;
      const kind =
        kindRoll < treeShare
          ? PROP_KIND.TREE
          : kindRoll < rockLimit
            ? PROP_KIND.ROCK
            : kindRoll < rockLimit + mushroomShare
              ? PROP_KIND.MUSHROOM
              : PROP_KIND.GRASS;

      const sizeHash = hash32(worldSeed, globalCellX, globalCellZ, SIZE_SALT);
      const scale = SCALE_RANGE[kind];

      const offset = count * PROP_STRIDE;
      target[offset + PROP_FIELD.KIND] = kind;
      target[offset + PROP_FIELD.X_MM] = xMm;
      target[offset + PROP_FIELD.Z_MM] = zMm;
      target[offset + PROP_FIELD.ROTATION_MRAD] = (sizeHash >>> 8) % TWO_PI_MRAD;
      target[offset + PROP_FIELD.SCALE_THOUSANDTHS] =
        scale.minimum + (sizeHash % (scale.maximum - scale.minimum + 1));
      target[offset + PROP_FIELD.Y_MM] = terrainCellHeightLevel(terrainCode) * TERRAIN_HEIGHT_STEP_MM;
      count += 1;
    }
  }

  return count;
}

/** @typedef {{ kind: number, x: number, y: number, z: number, rotation: number, scale: number }} ChunkProp */

/**
 * 把整数放置记录解码成米与弧度。整数除以 1000 在两端都是同一个
 * IEEE 754 结果，所以解码不会破坏跨端一致性。
 * @param {Int32Array} buffer
 * @param {number} count
 * @returns {ChunkProp[]}
 */
export function readChunkProps(buffer, count) {
  const props = [];
  for (let index = 0; index < count; index += 1) {
    const offset = index * PROP_STRIDE;
    props.push({
      kind: buffer[offset + PROP_FIELD.KIND],
      x: buffer[offset + PROP_FIELD.X_MM] / 1000,
      y: buffer[offset + PROP_FIELD.Y_MM] / 1000,
      z: buffer[offset + PROP_FIELD.Z_MM] / 1000,
      rotation: buffer[offset + PROP_FIELD.ROTATION_MRAD] / 1000,
      scale: buffer[offset + PROP_FIELD.SCALE_THOUSANDTHS] / 1000,
    });
  }
  return props;
}

/**
 * 便捷入口：自行分配缓冲区并解码，供测试与服务端偶发查询使用。
 * 渲染路径请走 generateChunkProps + 复用缓冲区。
 * @param {number} worldSeed
 * @param {number} chunkX
 * @param {number} chunkZ
 * @returns {ChunkProp[]}
 */
export function generateChunkContent(worldSeed, chunkX, chunkZ) {
  const buffer = new Int32Array(PROP_BUFFER_LENGTH);
  return readChunkProps(buffer, generateChunkProps(worldSeed, chunkX, chunkZ, buffer));
}
