/**
 * chunk 坐标系。
 *
 * 世界坐标（米）、chunk 坐标（整数格）和 chunk key（字符串）之间的换算，
 * 是渲染流式加载、服务端 chunk 订阅和物件差异定位共同的地址系统，
 * 所以单独成模块，任何一端都不要自己再写一遍取整逻辑。
 */

import { CHUNK_SIZE, isChunkInsideWorld } from './worldConfig.mjs';

/** @typedef {{ chunkX: number, chunkZ: number }} ChunkCoordinate */

/**
 * 世界坐标（米）落在哪个 chunk 上。负坐标向下取整，保证边界不重叠。
 * @param {number} worldValue
 * @returns {number}
 */
export function toChunkCoordinate(worldValue) {
  return Math.floor(worldValue / CHUNK_SIZE);
}

/**
 * chunk 坐标的字符串 key，用于 Map 索引与网络传输。
 * @param {number} chunkX
 * @param {number} chunkZ
 * @returns {string}
 */
export function toChunkKey(chunkX, chunkZ) {
  return `${chunkX}:${chunkZ}`;
}

/**
 * 解析 chunk key，格式非法时返回 undefined。
 * @param {string} key
 * @returns {ChunkCoordinate | undefined}
 */
export function parseChunkKey(key) {
  const match = /^(-?\d+):(-?\d+)$/.exec(String(key));
  if (!match) return undefined;
  return { chunkX: Number(match[1]), chunkZ: Number(match[2]) };
}

/**
 * chunk 的最小角世界坐标（米）。
 * @param {number} chunkCoordinate
 * @returns {number}
 */
export function chunkOrigin(chunkCoordinate) {
  return chunkCoordinate * CHUNK_SIZE;
}

/**
 * chunk 的中心世界坐标（米）。
 * @param {number} chunkCoordinate
 * @returns {number}
 */
export function chunkCenter(chunkCoordinate) {
  return chunkCoordinate * CHUNK_SIZE + CHUNK_SIZE / 2;
}

/**
 * 两个 chunk 之间的切比雪夫距离，也就是「相隔几圈」。
 * 加载与卸载判定都用它，因为加载区域是正方形而不是圆形。
 * @param {number} fromX
 * @param {number} fromZ
 * @param {number} toX
 * @param {number} toZ
 * @returns {number}
 */
export function chunkRingDistance(fromX, fromZ, toX, toZ) {
  return Math.max(Math.abs(toX - fromX), Math.abs(toZ - fromZ));
}

/**
 * 列出以某个 chunk 为中心、指定圈数内且位于世界范围内的全部 chunk。
 * 结果按到中心的欧氏距离升序，调用方据此优先构建离玩家最近的 chunk。
 * @param {number} centerX
 * @param {number} centerZ
 * @param {number} radius
 * @returns {Array<{ chunkX: number, chunkZ: number, key: string, distanceSquared: number }>}
 */
export function listChunksInRadius(centerX, centerZ, radius) {
  const chunks = [];
  for (let chunkX = centerX - radius; chunkX <= centerX + radius; chunkX += 1) {
    for (let chunkZ = centerZ - radius; chunkZ <= centerZ + radius; chunkZ += 1) {
      if (!isChunkInsideWorld(chunkX, chunkZ)) continue;
      const offsetX = chunkX - centerX;
      const offsetZ = chunkZ - centerZ;
      chunks.push({
        chunkX,
        chunkZ,
        key: toChunkKey(chunkX, chunkZ),
        distanceSquared: offsetX * offsetX + offsetZ * offsetZ,
      });
    }
  }
  chunks.sort((left, right) => left.distanceSquared - right.distanceSquared);
  return chunks;
}
