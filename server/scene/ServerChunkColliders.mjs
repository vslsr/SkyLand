/**
 * 房间 DS 侧的 chunk 静态碰撞常驻策略。
 *
 * 服务端不建几何体，但它必须知道树和石头在哪，否则玩家会被客户端预测挡住、
 * 又被服务端和解拉回去，走在林子里就会不停抖动。碰撞体由世界种子推导，
 * 和客户端是同一份数据，所以不需要同步任何东西。
 *
 * 「哪些 chunk 是活的」由 ChunkResidency 统一决定，这里只负责装载内容：
 * 碰撞体只服务玩家自己的推出解算，所以半径比可交互 Actor 小一圈就够了。
 */

import { PROP_BUFFER_LENGTH } from '../../shared/world/chunkContent.mjs';
import { buildChunkColliders } from '../../shared/world/chunkColliders.mjs';
import { toChunkKey } from '../../shared/world/chunkKey.mjs';
import { isChunkInsideWorld, toWorldSeed } from '../../shared/world/worldConfig.mjs';
import {
  createPropSkipMask,
  isPropSkipped,
  setPropSkipped as updatePropSkipMask,
} from '../../shared/world/generatedProp.mjs';
import { ChunkResidency } from './ChunkResidency.mjs';

const DEFAULT_RESIDENT_RADIUS = 1;
const DEFAULT_KEEP_RADIUS = 2;

export class ServerChunkColliders {
  /**
   * @param {{
   *   world: import('../../shared/collision/CollisionWorld.mjs').CollisionWorld,
   *   worldSeed?: number,
   *   enabled?: boolean,
   *   residentRadius?: number,
   *   keepRadius?: number,
   * }} options
   */
  constructor(options) {
    this.world = options.world;
    this.worldSeed = toWorldSeed(options.worldSeed);
    /** 只保存偏离默认生成结果的 chunk；数量与被砍过的树成正比。 */
    this.skipMasks = new Map();
    /** 放置记录缓冲区复用，避免每装载一个 chunk 都新建一次。 */
    this.propBuffer = new Int32Array(PROP_BUFFER_LENGTH);
    this.residency = new ChunkResidency({
      enabled: options.enabled !== false,
      residentRadius: options.residentRadius ?? DEFAULT_RESIDENT_RADIUS,
      keepRadius: options.keepRadius ?? DEFAULT_KEEP_RADIUS,
      onLoad: (chunkX, chunkZ, key) => this.rebuild(chunkX, chunkZ, key),
      onUnload: (key) => this.world.removeStaticGroup(key),
    });
  }

  get enabled() {
    return this.residency.enabled;
  }

  get residentRadius() {
    return this.residency.residentRadius;
  }

  get keepRadius() {
    return this.residency.keepRadius;
  }

  get residentCount() {
    return this.residency.residentCount;
  }

  get skippedPropCount() {
    let count = 0;
    for (const mask of this.skipMasks.values()) {
      count += popcount(mask.low) + popcount(mask.high);
    }
    return count;
  }

  getSkipMask(chunkX, chunkZ) {
    return this.skipMasks.get(toChunkKey(chunkX, chunkZ)) ?? createPropSkipMask();
  }

  /** 树状态偏离时仅重建所在 chunk 的静态碰撞组。 */
  setPropSkipped(chunkX, chunkZ, propIndex, skipped = true) {
    if (!isChunkInsideWorld(chunkX, chunkZ)) return false;
    const key = toChunkKey(chunkX, chunkZ);
    const previous = this.skipMasks.get(key);
    if (isPropSkipped(propIndex, previous) === skipped) return false;
    const next = updatePropSkipMask(previous, propIndex, skipped);
    if (next.low === 0 && next.high === 0) this.skipMasks.delete(key);
    else this.skipMasks.set(key, next);
    if (this.residency.has(key)) this.rebuild(chunkX, chunkZ, key);
    return true;
  }

  /** @param {number} x @param {number} z */
  ensureAround(x, z) {
    this.residency.ensureAround(x, z);
  }

  /** @param {Iterable<{ x: number, z: number }>} focuses */
  sync(focuses) {
    this.residency.sync(focuses);
  }

  /** 房间清空或场景重置：把这一份静态碰撞全部撤走。 */
  clear() {
    this.residency.clear();
    this.skipMasks.clear();
  }

  rebuild(chunkX, chunkZ, key = toChunkKey(chunkX, chunkZ)) {
    this.world.setStaticGroup(
      key,
      buildChunkColliders(
        this.worldSeed,
        chunkX,
        chunkZ,
        this.propBuffer,
        this.skipMasks.get(key),
      ),
    );
  }
}

function popcount(value) {
  let bits = value >>> 0;
  let count = 0;
  while (bits !== 0) {
    bits = (bits & (bits - 1)) >>> 0;
    count += 1;
  }
  return count;
}
