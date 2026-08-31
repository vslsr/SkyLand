/**
 * chunk 流式加载的调度计划。
 *
 * 「该加载哪些、该卸载哪些」是纯粹的集合运算，和 Three.js 无关，
 * 所以放在 shared 里：客户端用它决定建哪些网格，
 * 服务端将来做 chunk 订阅（物件差异按 chunk 下发）可以直接复用同一套判定。
 */

import { CHUNK_KEEP_RADIUS, CHUNK_LOAD_RADIUS, isChunkInsideWorld } from './worldConfig.mjs';
import {
  chunkRingDistance,
  listChunksInRadius,
  parseChunkKey,
  toChunkCoordinate,
} from './chunkKey.mjs';

/**
 * @typedef {object} ChunkStreamPlan
 * @property {number} centerX 焦点所在的 chunk X
 * @property {number} centerZ 焦点所在的 chunk Z
 * @property {Array<{ chunkX: number, chunkZ: number, key: string }>} load 待加载，按离焦点由近及远
 * @property {string[]} unload 待卸载的 chunk key
 */

/**
 * 计算一次加载计划。
 *
 * 加载半径与保留半径不同是刻意的：加载用 loadRadius，卸载要超出
 * keepRadius 才发生。两者相等时，玩家在 chunk 边界上来回走会导致
 * 同一批 chunk 反复构建与销毁，比不做流式加载还糟。
 *
 * @param {object} options
 * @param {number} options.focusX 焦点世界坐标 X（米）
 * @param {number} options.focusZ 焦点世界坐标 Z（米）
 * @param {Iterable<string>} options.loadedKeys 当前已经加载的 chunk key
 * @param {number} [options.loadRadius]
 * @param {number} [options.keepRadius]
 * @returns {ChunkStreamPlan}
 */
export function planChunkStream(options) {
  const {
    focusX,
    focusZ,
    loadedKeys,
    loadRadius = CHUNK_LOAD_RADIUS,
    keepRadius = Math.max(CHUNK_KEEP_RADIUS, loadRadius + 1),
  } = options;

  const centerX = toChunkCoordinate(focusX);
  const centerZ = toChunkCoordinate(focusZ);
  const loaded = loadedKeys instanceof Set ? loadedKeys : new Set(loadedKeys);

  const load = [];
  for (const candidate of listChunksInRadius(centerX, centerZ, loadRadius)) {
    if (loaded.has(candidate.key)) continue;
    load.push({ chunkX: candidate.chunkX, chunkZ: candidate.chunkZ, key: candidate.key });
  }

  const unload = [];
  for (const key of loaded) {
    const coordinate = parseChunkKey(key);
    // key 解析不出来说明数据已经损坏，直接卸载而不是留着一块无法定位的网格。
    if (!coordinate) {
      unload.push(key);
      continue;
    }
    if (!isChunkInsideWorld(coordinate.chunkX, coordinate.chunkZ)) {
      unload.push(key);
      continue;
    }
    if (chunkRingDistance(centerX, centerZ, coordinate.chunkX, coordinate.chunkZ) > keepRadius) {
      unload.push(key);
    }
  }

  return { centerX, centerZ, load, unload };
}
