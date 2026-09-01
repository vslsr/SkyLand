/**
 * 房间 DS 侧的 chunk 静态碰撞常驻策略。
 *
 * 服务端不建几何体，但它必须知道树和石头在哪，否则玩家会被客户端预测挡住、
 * 又被服务端和解拉回去，走在林子里就会不停抖动。碰撞体由世界种子推导，
 * 和客户端是同一份数据，所以不需要同步任何东西。
 *
 * 常驻集合有明确上界：只保留每名玩家所在 chunk 周围 residentRadius 圈内的
 * chunk，走出 keepRadius 之后卸载。也就是最多
 * 玩家数 × (2 × keepRadius + 1)² 个 chunk，与世界面积无关。
 * keepRadius 严格大于 residentRadius，站在 chunk 边界上来回走不会反复建了拆。
 *
 * 重算只在有人跨过 chunk 边界时发生：焦点 chunk 集合没变就直接返回，
 * 每个 tick 不做任何集合运算。
 */

import { PROP_BUFFER_LENGTH } from '../../shared/world/chunkContent.mjs';
import { buildChunkColliders } from '../../shared/world/chunkColliders.mjs';
import {
  chunkRingDistance,
  parseChunkKey,
  toChunkCoordinate,
  toChunkKey,
} from '../../shared/world/chunkKey.mjs';
import { isChunkInsideWorld, toWorldSeed } from '../../shared/world/worldConfig.mjs';
import {
  createPropSkipMask,
  isPropSkipped,
  setPropSkipped as updatePropSkipMask,
} from '../../shared/world/generatedTree.mjs';

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
    this.enabled = options.enabled !== false;
    this.residentRadius = Math.max(0, Math.floor(options.residentRadius ?? DEFAULT_RESIDENT_RADIUS));
    this.keepRadius = Math.max(
      this.residentRadius + 1,
      Math.floor(options.keepRadius ?? DEFAULT_KEEP_RADIUS),
    );
    /** @type {Set<string>} 已经登记进碰撞世界的 chunk key。 */
    this.resident = new Set();
    /** 只保存偏离默认生成结果的 chunk；数量与被砍过的树成正比。 */
    this.skipMasks = new Map();
    /** 上一次重算时的焦点 chunk 签名，用来跳过没有跨界的 tick。 */
    this.focusSignature = '';
    /** 放置记录缓冲区复用，避免每装载一个 chunk 都新建一次。 */
    this.propBuffer = new Int32Array(PROP_BUFFER_LENGTH);
  }

  get residentCount() {
    return this.resident.size;
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
    if (this.resident.has(key)) this.rebuild(chunkX, chunkZ, key);
    return true;
  }

  /**
   * 保证某个世界坐标周围的 chunk 已经就位。
   *
   * 玩家刚加入、瞬移或者刚跨过边界时，下一次 sync 之前就可能要做碰撞查询，
   * 这个入口把那一瞬间补上。常驻时只是一次 Map 查询：整块 3×3 是一起装载的，
   * 中心在就说明邻居也在。
   * @param {number} x
   * @param {number} z
   */
  ensureAround(x, z) {
    if (!this.enabled) return;
    const chunkX = toChunkCoordinate(x);
    const chunkZ = toChunkCoordinate(z);
    if (this.resident.has(toChunkKey(chunkX, chunkZ))) return;
    this.loadAround(chunkX, chunkZ);
  }

  /**
   * 按当前的焦点重算常驻集合。每个 tick 调用，跨界时才真的做事。
   * @param {Iterable<{ x: number, z: number }>} focuses 通常是全体玩家的位置
   */
  sync(focuses) {
    if (!this.enabled) return;
    const centers = [];
    for (const focus of focuses) {
      const chunkX = toChunkCoordinate(focus.x);
      const chunkZ = toChunkCoordinate(focus.z);
      centers.push({ chunkX, chunkZ, key: toChunkKey(chunkX, chunkZ) });
    }
    const signature = centers.map((center) => center.key).sort().join('|');
    if (signature === this.focusSignature) return;
    this.focusSignature = signature;

    for (const center of centers) this.loadAround(center.chunkX, center.chunkZ);
    this.evictOutside(centers);
  }

  /** 房间清空或场景重置：把这一份静态碰撞全部撤走。 */
  clear() {
    for (const key of this.resident) this.world.removeStaticGroup(key);
    this.resident.clear();
    this.skipMasks.clear();
    this.focusSignature = '';
  }

  /** @param {number} centerX @param {number} centerZ */
  loadAround(centerX, centerZ) {
    for (let chunkZ = centerZ - this.residentRadius; chunkZ <= centerZ + this.residentRadius; chunkZ += 1) {
      for (let chunkX = centerX - this.residentRadius; chunkX <= centerX + this.residentRadius; chunkX += 1) {
        if (!isChunkInsideWorld(chunkX, chunkZ)) continue;
        const key = toChunkKey(chunkX, chunkZ);
        if (this.resident.has(key)) continue;
        this.rebuild(chunkX, chunkZ, key);
        this.resident.add(key);
      }
    }
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

  /** @param {Array<{ chunkX: number, chunkZ: number }>} centers */
  evictOutside(centers) {
    for (const key of Array.from(this.resident)) {
      const coordinate = parseChunkKey(key);
      if (!coordinate) {
        this.world.removeStaticGroup(key);
        this.resident.delete(key);
        continue;
      }
      const nearAnyone = centers.some((center) => chunkRingDistance(
        center.chunkX,
        center.chunkZ,
        coordinate.chunkX,
        coordinate.chunkZ,
      ) <= this.keepRadius);
      if (nearAnyone) continue;
      this.world.removeStaticGroup(key);
      this.resident.delete(key);
    }
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
