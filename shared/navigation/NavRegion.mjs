/**
 * 搜索窗口：寻路能看见的那一小片世界。
 *
 * Minecraft 在寻路前会把目标附近的方块抄进一个 `PathNavigationRegion`，之后
 * 整个 A* 只读这份快照。理由有两条，SkyLand 这边一条不少：
 *
 * 1. **有界**。窗口是 `(2r+1)²` 格的定长数组，内存与世界面积无关。一只生物
 *    能规划的最远距离因此有硬上限，而不是「地图多大就能想多远」——这是大世界
 *    里唯一站得住的做法。
 * 2. **一致**。一次搜索里同一格问几十次，答案必须每次都一样，而且只算一次。
 *    分类一格要采样地形、查四个邻居的表面、查建造占位、再做一次圆形推出，
 *    不缓存的话 A* 的常数会翻十倍。
 *
 * 缓存用 stamp 而不是每次清零：清一次 2401 格的数组比大多数搜索本身还贵。
 * 每次 `prepare` 自增 stamp，格子上的 stamp 对不上就重算——和碰撞网格里
 * 那份去重用的是同一个手法。
 *
 * 窗口之外一律当作 BLOCKED。这不是近似，是定义：搜索半径就是这只生物的
 * 视野，走到边上还没找到目标，那它本来就该沿着最近的那个节点先走过去，
 * 到了新位置再想一次。
 */

import { MAX_NAV_SEARCH_RADIUS_CELLS, NAV_NODE } from './navConfig.mjs';
import { classifyNavCell } from './navNodeEvaluator.mjs';

export class NavRegion {
  /**
   * @param {{ radiusCells?: number }} [options]
   */
  constructor(options = {}) {
    const requested = Math.round(Number(options.radiusCells) || MAX_NAV_SEARCH_RADIUS_CELLS);
    this.radiusCells = Math.max(1, Math.min(MAX_NAV_SEARCH_RADIUS_CELLS, requested));
    this.width = this.radiusCells * 2 + 1;
    const cells = this.width * this.width;
    this.types = new Int8Array(cells);
    this.standYs = new Float64Array(cells);
    this.stamps = new Int32Array(cells);
    this.stamp = 0;
    this.originCellX = 0;
    this.originCellZ = 0;
    this.context = undefined;
    this.profile = undefined;
    /** 本次 prepare 之后真正分类过多少格。测试与性能计数用。 */
    this.classifiedCells = 0;
    this.scratch = { type: NAV_NODE.BLOCKED, standY: 0 };
  }

  get cellCount() {
    return this.width * this.width;
  }

  /**
   * 把窗口移到某一格上，并绑定这次搜索用的世界与体型。
   *
   * 世界没变、体型没换、窗口也没挪时保留缓存：一群生物挤在一起时，第二只
   * 之后的搜索直接吃第一只算好的分类。这是这个类唯一的跨调用状态，正确性
   * 由三个条件一起保证——差一个就重来。
   */
  prepare(context, profile, centerCellX, centerCellZ) {
    const reusable = this.context === context
      && this.contextRevision === context.revision
      && this.profile === profile
      && this.originCellX === centerCellX - this.radiusCells
      && this.originCellZ === centerCellZ - this.radiusCells;
    this.context = context;
    this.contextRevision = context.revision;
    this.profile = profile;
    this.originCellX = centerCellX - this.radiusCells;
    this.originCellZ = centerCellZ - this.radiusCells;
    if (reusable) return this;
    // Int32 的 stamp 走到头了就整片归零重来。约二十亿次搜索一次，
    // 但少了这一句就是一个只在长命房间里出现的错误缓存。
    if (this.stamp >= 0x7fff_ffff) {
      this.stamps.fill(0);
      this.stamp = 0;
    }
    this.stamp += 1;
    this.classifiedCells = 0;
    return this;
  }

  contains(cellX, cellZ) {
    const localX = cellX - this.originCellX;
    const localZ = cellZ - this.originCellZ;
    return localX >= 0 && localX < this.width && localZ >= 0 && localZ < this.width;
  }

  /** 窗口内的线性下标；窗口外返回 -1。A* 用它当节点 id，所以它必须是稠密的。 */
  indexOf(cellX, cellZ) {
    const localX = cellX - this.originCellX;
    const localZ = cellZ - this.originCellZ;
    if (localX < 0 || localX >= this.width || localZ < 0 || localZ >= this.width) return -1;
    return localZ * this.width + localX;
  }

  cellXOf(index) {
    return this.originCellX + (index % this.width);
  }

  cellZOf(index) {
    return this.originCellZ + Math.floor(index / this.width);
  }

  /** 按需分类并缓存。窗口外的格子一律 BLOCKED，且不会被写进缓存。 */
  ensure(index, cellX, cellZ) {
    if (this.stamps[index] === this.stamp) return index;
    classifyNavCell(this.context, this.profile, cellX, cellZ, this.scratch);
    this.types[index] = this.scratch.type;
    this.standYs[index] = this.scratch.standY;
    this.stamps[index] = this.stamp;
    this.classifiedCells += 1;
    return index;
  }

  typeAt(cellX, cellZ) {
    const index = this.indexOf(cellX, cellZ);
    if (index < 0) return NAV_NODE.BLOCKED;
    this.ensure(index, cellX, cellZ);
    return this.types[index];
  }

  standYAt(cellX, cellZ) {
    const index = this.indexOf(cellX, cellZ);
    if (index < 0) return 0;
    this.ensure(index, cellX, cellZ);
    return this.standYs[index];
  }

  typeAtIndex(index) {
    this.ensure(index, this.cellXOf(index), this.cellZOf(index));
    return this.types[index];
  }

  standYAtIndex(index) {
    this.ensure(index, this.cellXOf(index), this.cellZOf(index));
    return this.standYs[index];
  }
}
