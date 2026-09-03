/**
 * 稀疏地形覆盖层。
 *
 * 默认世界仍由 (worldSeed, cellX, cellZ) 纯函数生成；这里只保存与默认值不同的
 * 格子，并按 chunk 分桶。内存因此与“被玩家真正编辑过的格数”成正比，而不是
 * 与整张世界面积成正比。
 */

import { parseChunkKey, toChunkKey } from './chunkKey.mjs';
import {
  TERRAIN_GRID,
  TERRAIN_SHAPE,
} from './terrainConfig.mjs';
import {
  encodeTerrainCell,
  terrainCellBiome,
  terrainCellCodeAt,
  terrainCellHeightLevel,
  terrainCellShape,
  terrainCellSurface,
} from './terrainContent.mjs';
import { isChunkInsideWorld, toWorldSeed } from './worldConfig.mjs';

/**
 * @typedef {{ chunkX: number, chunkZ: number, key: string }} TerrainPatchChunk
 * @typedef {{
 *   globalCellX: number,
 *   globalCellZ: number,
 *   affectedChunks: readonly TerrainPatchChunk[],
 * }} TerrainPatchChange
 */

function cellAddress(globalCellX, globalCellZ) {
  const chunkX = Math.floor(globalCellX / TERRAIN_GRID);
  const chunkZ = Math.floor(globalCellZ / TERRAIN_GRID);
  const localX = globalCellX - chunkX * TERRAIN_GRID;
  const localZ = globalCellZ - chunkZ * TERRAIN_GRID;
  return {
    chunkX,
    chunkZ,
    localX,
    localZ,
    localIndex: localZ * TERRAIN_GRID + localX,
    key: toChunkKey(chunkX, chunkZ),
  };
}

function normalizeCellCode(code) {
  if (!Number.isInteger(code)) throw new TypeError('地形格 code 必须是整数');
  const shape = terrainCellShape(code);
  if (shape < TERRAIN_SHAPE.FLAT || shape > TERRAIN_SHAPE.CORNER_LOW_NORTH_WEST) {
    throw new RangeError(`未知地形形状 ${shape}`);
  }
  return encodeTerrainCell(
    terrainCellHeightLevel(code),
    terrainCellSurface(code),
    shape,
    terrainCellBiome(code),
  );
}

function affectedChunksForCell(globalCellX, globalCellZ) {
  const address = cellAddress(globalCellX, globalCellZ);
  const chunks = new Map();
  const add = (chunkX, chunkZ) => {
    if (!isChunkInsideWorld(chunkX, chunkZ)) return;
    const key = toChunkKey(chunkX, chunkZ);
    chunks.set(key, { chunkX, chunkZ, key });
  };
  add(address.chunkX, address.chunkZ);
  // chunk 几何会读取边界外一格来建立断崖和岸线，只通知真正受影响的邻块。
  if (address.localX === 0) add(address.chunkX - 1, address.chunkZ);
  if (address.localX === TERRAIN_GRID - 1) add(address.chunkX + 1, address.chunkZ);
  if (address.localZ === 0) add(address.chunkX, address.chunkZ - 1);
  if (address.localZ === TERRAIN_GRID - 1) add(address.chunkX, address.chunkZ + 1);
  return [...chunks.values()];
}

export class TerrainPatchStore {
  #chunks = new Map();
  #listeners = new Set();
  #size = 0;

  constructor(worldSeed) {
    this.worldSeed = toWorldSeed(worldSeed);
  }

  /** 当前实际保存的覆盖格数量，不会为未编辑区域分配内存。 */
  get size() {
    return this.#size;
  }

  /** 返回覆盖值；没有 patch 时回退到确定性基础地形。 */
  cellCodeAt(globalCellX, globalCellZ) {
    const address = cellAddress(globalCellX, globalCellZ);
    return this.#chunks.get(address.key)?.get(address.localIndex)
      ?? terrainCellCodeAt(this.worldSeed, globalCellX, globalCellZ);
  }

  hasCell(globalCellX, globalCellZ) {
    const address = cellAddress(globalCellX, globalCellZ);
    return this.#chunks.get(address.key)?.has(address.localIndex) ?? false;
  }

  /**
   * 写入与默认地形不同的 code；写回默认值会自动删掉 patch。
   * @returns {boolean} 是否真的改变了覆盖层
   */
  setCellCode(globalCellX, globalCellZ, code) {
    const address = cellAddress(globalCellX, globalCellZ);
    if (!isChunkInsideWorld(address.chunkX, address.chunkZ)) {
      throw new RangeError(`地形格 (${globalCellX}, ${globalCellZ}) 位于世界范围外`);
    }
    const normalized = normalizeCellCode(code);
    const baseline = terrainCellCodeAt(this.worldSeed, globalCellX, globalCellZ);
    if (normalized === baseline) return this.resetCell(globalCellX, globalCellZ);

    let chunk = this.#chunks.get(address.key);
    if (!chunk) {
      chunk = new Map();
      this.#chunks.set(address.key, chunk);
    }
    if (chunk.get(address.localIndex) === normalized) return false;
    if (!chunk.has(address.localIndex)) this.#size += 1;
    chunk.set(address.localIndex, normalized);
    this.#emit(globalCellX, globalCellZ);
    return true;
  }

  resetCell(globalCellX, globalCellZ) {
    const address = cellAddress(globalCellX, globalCellZ);
    const chunk = this.#chunks.get(address.key);
    if (!chunk?.delete(address.localIndex)) return false;
    this.#size -= 1;
    if (chunk.size === 0) this.#chunks.delete(address.key);
    this.#emit(globalCellX, globalCellZ);
    return true;
  }

  /** 按 localIndex 升序导出一个 chunk，供后续存档与网络压缩直接消费。 */
  readChunk(chunkX, chunkZ) {
    const entries = [...(this.#chunks.get(toChunkKey(chunkX, chunkZ))?.entries() ?? [])]
      .sort((left, right) => left[0] - right[0]);
    const values = new Int32Array(entries.length * 2);
    for (let index = 0; index < entries.length; index += 1) {
      values[index * 2] = entries[index][0];
      values[index * 2 + 1] = entries[index][1];
    }
    return values;
  }

  /**
   * 扁平枚举全部覆盖格。新成员加入房间时用它一次补齐已有编辑。
   * 稀疏存储，所以长度是「被编辑过的格数」而不是世界面积。
   * @returns {Array<{ cellX: number, cellZ: number, code: number }>}
   */
  entries() {
    const result = [];
    for (const [key, cells] of this.#chunks) {
      const coordinate = parseChunkKey(key);
      if (!coordinate) continue;
      for (const [localIndex, code] of cells) {
        result.push({
          cellX: coordinate.chunkX * TERRAIN_GRID + (localIndex % TERRAIN_GRID),
          cellZ: coordinate.chunkZ * TERRAIN_GRID + Math.floor(localIndex / TERRAIN_GRID),
          code,
        });
      }
    }
    return result;
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('地形 patch listener 必须是函数');
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(globalCellX, globalCellZ) {
    if (this.#listeners.size === 0) return;
    /** @type {TerrainPatchChange} */
    const change = {
      globalCellX,
      globalCellZ,
      affectedChunks: affectedChunksForCell(globalCellX, globalCellZ),
    };
    for (const listener of this.#listeners) listener(change);
  }
}
