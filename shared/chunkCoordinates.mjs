/**
 * 世界分块坐标。
 *
 * 浏览器用它决定加载哪些地块，房间进程用同一套划分做兴趣区过滤，
 * 所以放在前后端共用的位置。分块以原点为中心对齐：地块 (0,0) 覆盖
 * [-16, 16)，出生地正好落在它里面。
 */

export const CHUNK_SIZE = 32;
export const CHUNK_HALF_SIZE = CHUNK_SIZE / 2;

/** 一个地块内所有内容的包围球半径，用于视锥剔除。 */
export const CHUNK_BOUNDING_RADIUS = 26;

/** @typedef {{ x: number, z: number }} ChunkCoordinate */

/**
 * @param {number} worldValue
 * @returns {number}
 */
export function toChunkAxis(worldValue) {
  return Math.floor((worldValue + CHUNK_HALF_SIZE) / CHUNK_SIZE);
}

/**
 * @param {number} worldX
 * @param {number} worldZ
 * @returns {ChunkCoordinate}
 */
export function toChunkCoordinate(worldX, worldZ) {
  return { x: toChunkAxis(worldX), z: toChunkAxis(worldZ) };
}

/**
 * @param {number} chunkX
 * @param {number} chunkZ
 * @returns {string}
 */
export function chunkKey(chunkX, chunkZ) {
  return `${chunkX}:${chunkZ}`;
}

/** 地块中心的世界坐标。 @returns {ChunkCoordinate} */
export function chunkCenter(chunkX, chunkZ) {
  return { x: chunkX * CHUNK_SIZE, z: chunkZ * CHUNK_SIZE };
}

/** 出生地是唯一手工布置的地块，其余由 worldGen 程序化生成。 */
export function isSpawnChunk(chunkX, chunkZ) {
  return chunkX === 0 && chunkZ === 0;
}

/** 切比雪夫距离：方形加载半径下判断地块是否在范围内。 */
export function chunkDistance(fromX, fromZ, toX, toZ) {
  return Math.max(Math.abs(fromX - toX), Math.abs(fromZ - toZ));
}

/**
 * 列出以某个地块为中心、半径 radius 的方形范围内的所有地块，
 * 按到中心的距离从近到远排序，让分帧构建优先补上离玩家最近的。
 * @returns {ChunkCoordinate[]}
 */
export function listChunksInRadius(centerX, centerZ, radius) {
  const chunks = [];
  for (let z = centerZ - radius; z <= centerZ + radius; z += 1) {
    for (let x = centerX - radius; x <= centerX + radius; x += 1) {
      chunks.push({ x, z });
    }
  }
  chunks.sort(
    (a, b) =>
      (a.x - centerX) ** 2 + (a.z - centerZ) ** 2 - ((b.x - centerX) ** 2 + (b.z - centerZ) ** 2),
  );
  return chunks;
}
