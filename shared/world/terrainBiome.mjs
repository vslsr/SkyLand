/**
 * 确定性群系分区。
 *
 * 思路取自《饥荒》：那边的世界不是「逐格采样一张噪声图」，而是先把若干**房间**
 * （每间有自己的地皮类型）连成图，再把图铺进 Voronoi 分区，一间房占一整片不规则
 * 区域。地皮因此是成片的，不会在阈值附近碎成杂色。
 *
 * SkyLand 的 chunk 必须能被单独生成，跑不了饥荒那种全局图布局，于是把同一个结构
 * 做成局部可算的版本：
 *
 * 1. 世界按 BIOME_REGION_SIZE 格划成区块，每个区块用一次哈希放一个**站点**；
 * 2. 一格属于最近站点所在的区块 —— 这就是 Voronoi，边界不规则但整片一致；
 * 3. 站点自己按「温度 × 湿度」两张低频噪声查表定群系。气候格点与区块同尺度，
 *    相邻区块共享格点因而相关但不相同：同群系的区块连成带，阈值附近的相邻区块
 *    则分给不同地皮，沿着不规则边界互相咬合。
 *
 * 全程 32 位整数：与 native/chunkgen/src/biome.rs 必须逐位一致，
 * 否则同一颗种子在浏览器与房间进程里会长出两个世界。
 */

import { hash32, valueNoise } from './hash.mjs';
import { TERRAIN_BIOME } from './terrainConfig.mjs';

/** 区块边长（地形格）。2⁵ 格 = 64 米，一片群系斑块的量级。 */
export const BIOME_REGION_SHIFT = 5;
export const BIOME_REGION_SIZE = 1 << BIOME_REGION_SHIFT;

/**
 * 站点到区块边界的内缩量，以及它剩下的抖动跨度。
 *
 * 内缩不是为了好看，是为了让「只扫 3×3 个区块」等于精确的 Voronoi：
 * 本区块站点最远也就 √2 × (SIZE-1-MARGIN) ≈ 32.5 格，而隔一个区块的站点至少
 * 在 SIZE + MARGIN = 40 格外，永远抢不走本格。少了这条，就得扫 5×5。
 */
export const BIOME_SITE_MARGIN = 8;
export const BIOME_SITE_SPAN = BIOME_REGION_SIZE - BIOME_SITE_MARGIN * 2;

/**
 * 气候噪声的特征尺度：2⁵ 格 = 64 米，与区块同尺度。
 *
 * 取同尺度是量出来的：更大（128 米）时整张 512 米的图只装得下四个气候格，
 * 一颗种子经常整个世界只有两三种地皮；更小则相邻区块彼此独立，退化成马赛克。
 * 同尺度下相邻区块共享噪声格点，因而相关但不相同——群系连成几块相邻区块的
 * 带，斑块平均跨度约 78 米。
 */
const BIOME_CLIMATE_SHIFT = 5;

const BIOME_SITE_SALT = 0x4d2c_8f13;
const BIOME_TEMPERATURE_SALT = 0x1a7b_e35d;
const BIOME_MOISTURE_SALT = 0x63f0_9c21;

/**
 * 每个站点在气候值上的随机偏移量（±32）。
 *
 * 没有它，一条气候带里的区块会整齐地取到同一个群系，Voronoi 的边界完全看不
 * 出来。有了它，阈值附近的相邻区块会分到不同群系，两种地皮沿着不规则边界互相
 * 咬进去——饥荒的地图边缘就是这个味道。
 */
const BIOME_VARIATION_MASK = 63;
const BIOME_VARIATION_HALF = 32;

/**
 * 气候阈值。
 *
 * 值噪声是双线性插值，取值明显集中在中段，按「看起来居中」拍出来的阈值会让
 * 草原缩到不足两成。这几个数是按分位数反解的：雪地取温度最低的 15%，沙地取
 * 温度最高 40% 与湿度最低 37.5% 的交集，烂泥地取湿度最高的约 18%，石头地取
 * 温带里湿度最低的三分之一，剩下的都是草原。
 *
 * 实测 125 颗种子的 384 米活动区：草原 37%、沙地 16%、烂泥地 15%、雪地 17%、
 * 石头地 15%，且没有一颗种子缺掉某一种地皮。
 */
const SNOW_TEMPERATURE_MAXIMUM = 78;
const SAND_TEMPERATURE_MINIMUM = 137;
const SAND_MOISTURE_MAXIMUM = 112;
const MUD_MOISTURE_MINIMUM = 172;
const ROCK_MOISTURE_MAXIMUM = 106;

/** 区块站点的哈希。抖动与气候扰动都从这一次取值里分位取用。 */
function biomeSiteHash(worldSeed, regionX, regionZ) {
  return hash32(worldSeed, regionX, regionZ, BIOME_SITE_SALT);
}

function biomeSiteX(regionX, siteHash) {
  return (regionX << BIOME_REGION_SHIFT) + BIOME_SITE_MARGIN + (siteHash % BIOME_SITE_SPAN);
}

function biomeSiteZ(regionZ, siteHash) {
  return (regionZ << BIOME_REGION_SHIFT) + BIOME_SITE_MARGIN + ((siteHash >>> 8) % BIOME_SITE_SPAN);
}

function clampClimate(value) {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

/** 站点的温度：低频气候带 + 站点自己的扰动，[0, 255]。 */
function siteTemperature(worldSeed, siteX, siteZ, siteHash) {
  return clampClimate(
    valueNoise(worldSeed ^ BIOME_TEMPERATURE_SALT, siteX, siteZ, BIOME_CLIMATE_SHIFT)
    + (((siteHash >>> 16) & BIOME_VARIATION_MASK) - BIOME_VARIATION_HALF),
  );
}

/** 站点的湿度，与温度同构但取哈希的另一段，两者互不相关。 */
function siteMoisture(worldSeed, siteX, siteZ, siteHash) {
  return clampClimate(
    valueNoise(worldSeed ^ BIOME_MOISTURE_SALT, siteX, siteZ, BIOME_CLIMATE_SHIFT)
    + (((siteHash >>> 24) & BIOME_VARIATION_MASK) - BIOME_VARIATION_HALF),
  );
}

/**
 * 站点位置与它的哈希。测试与调试用；生成路径在循环里直接取分量，不产生临时对象。
 * @returns {{ x: number, z: number, hash: number }}
 */
export function terrainBiomeRegionSite(worldSeed, regionX, regionZ, target = {}) {
  const hash = biomeSiteHash(worldSeed, regionX, regionZ);
  target.x = biomeSiteX(regionX, hash);
  target.z = biomeSiteZ(regionZ, hash);
  target.hash = hash;
  return target;
}

/**
 * 「温度 × 湿度」查表。冷的一律是雪地，热而干是沙地，湿到头是烂泥地，
 * 温带里干的一侧露出石头地，剩下的全是草原——草原因此始终是世界的底色。
 */
export function terrainBiomeFromClimate(temperature, moisture) {
  if (temperature <= SNOW_TEMPERATURE_MAXIMUM) return TERRAIN_BIOME.SNOW;
  if (temperature >= SAND_TEMPERATURE_MINIMUM && moisture <= SAND_MOISTURE_MAXIMUM) {
    return TERRAIN_BIOME.SAND;
  }
  if (moisture >= MUD_MOISTURE_MINIMUM) return TERRAIN_BIOME.MUD;
  if (moisture <= ROCK_MOISTURE_MAXIMUM) return TERRAIN_BIOME.ROCK;
  return TERRAIN_BIOME.GRASSLAND;
}

/**
 * 一格的群系。3×3 区块里取最近站点，再由站点的气候定型。
 *
 * 相同距离时按固定的扫描顺序取先到的那个：两端的循环顺序一致，
 * 所以「谁先到」在浏览器与 Rust 里是同一个答案。
 */
export function terrainBiomeAt(worldSeed, globalCellX, globalCellZ) {
  const regionX = globalCellX >> BIOME_REGION_SHIFT;
  const regionZ = globalCellZ >> BIOME_REGION_SHIFT;
  let nearestDistance = 0x7fffffff;
  let nearestX = 0;
  let nearestZ = 0;
  let nearestHash = 0;
  for (let offsetZ = -1; offsetZ <= 1; offsetZ += 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      const candidateRegionX = regionX + offsetX;
      const candidateRegionZ = regionZ + offsetZ;
      const siteHash = biomeSiteHash(worldSeed, candidateRegionX, candidateRegionZ);
      const siteX = biomeSiteX(candidateRegionX, siteHash);
      const siteZ = biomeSiteZ(candidateRegionZ, siteHash);
      const deltaX = siteX - globalCellX;
      const deltaZ = siteZ - globalCellZ;
      const distance = deltaX * deltaX + deltaZ * deltaZ;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestX = siteX;
        nearestZ = siteZ;
        nearestHash = siteHash;
      }
    }
  }
  return terrainBiomeFromClimate(
    siteTemperature(worldSeed, nearestX, nearestZ, nearestHash),
    siteMoisture(worldSeed, nearestX, nearestZ, nearestHash),
  );
}
