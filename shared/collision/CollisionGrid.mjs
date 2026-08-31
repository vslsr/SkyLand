/**
 * 均匀网格宽相（broad phase）。
 *
 * 碰撞检测的成本来自「拿一个查询去比对所有碰撞体」。世界一大，碰撞体数量
 * 就随加载面积线性增长，而每次查询真正相关的只有身边那几个。均匀网格把
 * XZ 平面切成边长固定的格子，碰撞体登记进它 AABB 覆盖到的格子，查询只访问
 * 与查询区域相交的格子——成本从「碰撞体总数」变成「查询区域附近的密度」。
 *
 * 为什么是均匀网格而不是四叉树/BVH：
 * - 这个世界的碰撞体尺寸相近（树、石头、船），密度也均匀，均匀网格的
 *   最坏情况和平均情况几乎一样，而且插入/删除是 O(1)，动态 Actor 每帧
 *   刷新不需要重建树。
 * - 格子按需创建、空了就删，内存跟「已加载的碰撞体」走，不跟世界面积走。
 *   这是大世界能用它的前提。
 *
 * 边界纪律：
 * - 单个碰撞体最多登记进 maximumCellsPerEntry 个格子；超过这个数的巨大
 *   碰撞体进 oversized 列表，每次查询都会看它。列表长度因此就是「异常大的
 *   碰撞体」的数量，而不是它们覆盖的面积。
 * - 去重不分配：每条记录带一个 stamp，查询前自增全局 stamp，访问过的记录
 *   打上当前 stamp。没有 Set，没有临时数组。
 */

import { COLLISION_LAYER_ALL } from './collisionLayers.mjs';

const DEFAULT_CELL_SIZE = 8;
const DEFAULT_MAXIMUM_CELLS_PER_ENTRY = 16;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** @typedef {{ minimumX: number, maximumX: number, minimumZ: number, maximumZ: number }} CollisionBounds */

export class CollisionGrid {
  /**
   * @param {{ cellSize?: number, maximumCellsPerEntry?: number }} [options]
   */
  constructor(options = {}) {
    const cellSize = finiteNumber(options.cellSize, DEFAULT_CELL_SIZE);
    this.cellSize = cellSize > 0 ? cellSize : DEFAULT_CELL_SIZE;
    this.maximumCellsPerEntry = Math.max(
      1,
      Math.floor(finiteNumber(options.maximumCellsPerEntry, DEFAULT_MAXIMUM_CELLS_PER_ENTRY)),
    );
    /** @type {Map<string, object[]>} 只为真正有碰撞体的格子分配数组。 */
    this.cells = new Map();
    /** @type {Map<string, object>} */
    this.entries = new Map();
    /** @type {object[]} 跨格过多的碰撞体，查询时无条件访问。 */
    this.oversized = [];
    this.stamp = 0;
  }

  get size() {
    return this.entries.size;
  }

  /** 当前占用的格子数。测试用它确认空格子被回收了。 */
  get cellCount() {
    return this.cells.size;
  }

  get oversizedCount() {
    return this.oversized.length;
  }

  toCellCoordinate(worldValue) {
    return Math.floor(finiteNumber(worldValue) / this.cellSize);
  }

  /**
   * 登记或更新一个碰撞体。同一个 id 再次插入就是移动它。
   * @param {string} id
   * @param {CollisionBounds} bounds 世界 AABB（XZ 平面）
   * @param {unknown} value 查询时回传给调用方的载荷
   * @param {number} [layers]
   */
  insert(id, bounds, value, layers = COLLISION_LAYER_ALL) {
    const minimumX = finiteNumber(bounds.minimumX);
    const maximumX = Math.max(minimumX, finiteNumber(bounds.maximumX));
    const minimumZ = finiteNumber(bounds.minimumZ);
    const maximumZ = Math.max(minimumZ, finiteNumber(bounds.maximumZ));
    const cellMinimumX = this.toCellCoordinate(minimumX);
    const cellMaximumX = this.toCellCoordinate(maximumX);
    const cellMinimumZ = this.toCellCoordinate(minimumZ);
    const cellMaximumZ = this.toCellCoordinate(maximumZ);
    const cellCount = (cellMaximumX - cellMinimumX + 1) * (cellMaximumZ - cellMinimumZ + 1);
    const oversized = cellCount > this.maximumCellsPerEntry;

    const existing = this.entries.get(id);
    if (existing) {
      // 移动一小段距离通常不会跨格。格范围没变就只改数值，省掉全部
      // Map 操作——动态 Actor 每帧刷新走的就是这条路径。
      const sameCells = existing.oversized === oversized
        && existing.cellMinimumX === cellMinimumX
        && existing.cellMaximumX === cellMaximumX
        && existing.cellMinimumZ === cellMinimumZ
        && existing.cellMaximumZ === cellMaximumZ;
      if (sameCells) {
        existing.minimumX = minimumX;
        existing.maximumX = maximumX;
        existing.minimumZ = minimumZ;
        existing.maximumZ = maximumZ;
        existing.value = value;
        existing.layers = layers;
        return existing;
      }
      this.remove(id);
    }

    const entry = {
      id,
      minimumX,
      maximumX,
      minimumZ,
      maximumZ,
      value,
      layers,
      oversized,
      cellMinimumX,
      cellMaximumX,
      cellMinimumZ,
      cellMaximumZ,
      stamp: 0,
    };
    this.entries.set(id, entry);
    if (oversized) {
      this.oversized.push(entry);
      return entry;
    }
    for (let cellZ = cellMinimumZ; cellZ <= cellMaximumZ; cellZ += 1) {
      for (let cellX = cellMinimumX; cellX <= cellMaximumX; cellX += 1) {
        const key = `${cellX}:${cellZ}`;
        const cell = this.cells.get(key);
        if (cell) cell.push(entry);
        else this.cells.set(key, [entry]);
      }
    }
    return entry;
  }

  /**
   * @param {string} id
   * @returns {boolean} 是否真的删掉了一个碰撞体
   */
  remove(id) {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id);
    if (entry.oversized) {
      const index = this.oversized.indexOf(entry);
      if (index >= 0) this.oversized.splice(index, 1);
      return true;
    }
    for (let cellZ = entry.cellMinimumZ; cellZ <= entry.cellMaximumZ; cellZ += 1) {
      for (let cellX = entry.cellMinimumX; cellX <= entry.cellMaximumX; cellX += 1) {
        const key = `${cellX}:${cellZ}`;
        const cell = this.cells.get(key);
        if (!cell) continue;
        const index = cell.indexOf(entry);
        if (index >= 0) cell.splice(index, 1);
        // 空格子必须回收，否则走过的地方会留下永久增长的 Map。
        if (cell.length === 0) this.cells.delete(key);
      }
    }
    return true;
  }

  has(id) {
    return this.entries.has(id);
  }

  clear() {
    this.cells.clear();
    this.entries.clear();
    this.oversized.length = 0;
  }

  /**
   * 访问与给定 AABB 相交的碰撞体。每个碰撞体最多访问一次。
   * @param {number} minimumX
   * @param {number} minimumZ
   * @param {number} maximumX
   * @param {number} maximumZ
   * @param {number} layers 层掩码，0 表示不过滤
   * @param {(value: unknown, entry: object) => void} visit
   * @returns {number} 实际访问到的碰撞体数量
   */
  forEachInAabb(minimumX, minimumZ, maximumX, maximumZ, layers, visit) {
    const mask = layers || COLLISION_LAYER_ALL;
    this.stamp += 1;
    const stamp = this.stamp;
    let visited = 0;

    for (const entry of this.oversized) {
      entry.stamp = stamp;
      if ((entry.layers & mask) === 0) continue;
      if (entry.maximumX < minimumX || entry.minimumX > maximumX) continue;
      if (entry.maximumZ < minimumZ || entry.minimumZ > maximumZ) continue;
      visit(entry.value, entry);
      visited += 1;
    }

    const cellMinimumX = this.toCellCoordinate(minimumX);
    const cellMaximumX = this.toCellCoordinate(maximumX);
    const cellMinimumZ = this.toCellCoordinate(minimumZ);
    const cellMaximumZ = this.toCellCoordinate(maximumZ);
    for (let cellZ = cellMinimumZ; cellZ <= cellMaximumZ; cellZ += 1) {
      for (let cellX = cellMinimumX; cellX <= cellMaximumX; cellX += 1) {
        const cell = this.cells.get(`${cellX}:${cellZ}`);
        if (!cell) continue;
        for (const entry of cell) {
          if (entry.stamp === stamp) continue;
          entry.stamp = stamp;
          if ((entry.layers & mask) === 0) continue;
          if (entry.maximumX < minimumX || entry.minimumX > maximumX) continue;
          if (entry.maximumZ < minimumZ || entry.minimumZ > maximumZ) continue;
          visit(entry.value, entry);
          visited += 1;
        }
      }
    }
    return visited;
  }

  /**
   * 访问可能与圆相交的碰撞体。用圆的 AABB 做粗筛，窄相自己判精确距离。
   * @param {number} x
   * @param {number} z
   * @param {number} radius
   * @param {number} layers
   * @param {(value: unknown, entry: object) => void} visit
   * @returns {number}
   */
  forEachInCircle(x, z, radius, layers, visit) {
    const safeRadius = Math.max(0, finiteNumber(radius));
    const centerX = finiteNumber(x);
    const centerZ = finiteNumber(z);
    return this.forEachInAabb(
      centerX - safeRadius,
      centerZ - safeRadius,
      centerX + safeRadius,
      centerZ + safeRadius,
      layers,
      visit,
    );
  }
}
