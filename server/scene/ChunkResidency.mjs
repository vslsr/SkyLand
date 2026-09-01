/**
 * 「玩家周围哪些 chunk 是活的」这一条策略的唯一实现。
 *
 * 房间 DS 上有多套东西需要跟着玩家滑动：静态碰撞体、可交互的生成 Actor，
 * 以后还会有别的。它们的加载内容不同，但「什么时候加载、什么时候卸载」
 * 完全一样，所以这里只保留那一份策略，具体装什么由 onLoad / onUnload 决定。
 *
 * 两条纪律和客户端 ChunkStreamer 一致：
 *
 * 1. 常驻集合有明确上界——只保留每名玩家所在 chunk 周围 residentRadius 圈内的
 *    chunk，走出 keepRadius 之后才卸载。上界是
 *    玩家数 × (2 × keepRadius + 1)²，与世界面积无关。
 * 2. keepRadius 严格大于 residentRadius，站在 chunk 边界上来回走不会反复
 *    建了拆；没有人跨过边界时 sync 直接返回，每个 tick 不做任何集合运算。
 */

import {
  chunkRingDistance,
  parseChunkKey,
  toChunkCoordinate,
  toChunkKey,
} from '../../shared/world/chunkKey.mjs';
import { isChunkInsideWorld } from '../../shared/world/worldConfig.mjs';

export class ChunkResidency {
  /**
   * @param {{
   *   residentRadius?: number,
   *   keepRadius?: number,
   *   enabled?: boolean,
   *   onLoad: (chunkX: number, chunkZ: number, key: string) => void,
   *   onUnload: (key: string, chunkX: number, chunkZ: number) => void,
   * }} options
   */
  constructor(options) {
    this.enabled = options.enabled !== false;
    this.residentRadius = Math.max(0, Math.floor(options.residentRadius ?? 1));
    this.keepRadius = Math.max(
      this.residentRadius + 1,
      Math.floor(options.keepRadius ?? this.residentRadius + 1),
    );
    this.onLoad = options.onLoad;
    this.onUnload = options.onUnload;
    /** @type {Set<string>} 已经装载的 chunk key。 */
    this.resident = new Set();
    /** 上一次重算时的焦点 chunk 签名，用来跳过没有跨界的 tick。 */
    this.focusSignature = '';
  }

  get residentCount() {
    return this.resident.size;
  }

  /** @param {string} key */
  has(key) {
    return this.resident.has(key);
  }

  /**
   * 保证某个世界坐标周围的 chunk 已经就位。
   *
   * 玩家刚加入、瞬移或者刚跨过边界时，下一次 sync 之前就可能要用到这一片，
   * 这个入口把那一瞬间补上。常驻时只是一次 Set 查询：整片是一起装载的，
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

  /** 房间清空或场景重置：把已装载的全部卸掉。 */
  clear() {
    for (const key of this.resident) {
      const coordinate = parseChunkKey(key);
      this.onUnload(key, coordinate?.chunkX ?? 0, coordinate?.chunkZ ?? 0);
    }
    this.resident.clear();
    this.focusSignature = '';
  }

  /** @param {number} centerX @param {number} centerZ */
  loadAround(centerX, centerZ) {
    for (let chunkZ = centerZ - this.residentRadius; chunkZ <= centerZ + this.residentRadius; chunkZ += 1) {
      for (let chunkX = centerX - this.residentRadius; chunkX <= centerX + this.residentRadius; chunkX += 1) {
        if (!isChunkInsideWorld(chunkX, chunkZ)) continue;
        const key = toChunkKey(chunkX, chunkZ);
        if (this.resident.has(key)) continue;
        this.onLoad(chunkX, chunkZ, key);
        this.resident.add(key);
      }
    }
  }

  /** @param {Array<{ chunkX: number, chunkZ: number }>} centers */
  evictOutside(centers) {
    for (const key of Array.from(this.resident)) {
      const coordinate = parseChunkKey(key);
      if (!coordinate) {
        this.onUnload(key, 0, 0);
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
      this.onUnload(key, coordinate.chunkX, coordinate.chunkZ);
      this.resident.delete(key);
    }
  }
}
