/**
 * 会走路的 agent 的邻居查询表：一层按格分桶的稀疏空间哈希。
 *
 * 避障每 tick 每只都要问一次「我身边三米内有谁」。老老实实两两比一遍是 O(n²)，
 * 二十只还好，人群一多就直接吃掉 tick 预算；而这个问题的答案永远只和**附近**
 * 有关，所以按格分桶之后每次只用看九到二十五个桶。
 *
 * 三个刻意的选择，都是为了让每 tick 的重建不产生垃圾：
 *
 * 1. **桶键是打包好的整数**，不是拼出来的字符串——每 tick 每只一次字符串拼接，
 *    在一个 16.6 毫秒的 tick 里是实打实的 GC 压力。
 * 2. **桶里存的是下标**，不是对象引用或 id：回读邻居时是 O(1) 数组访问，
 *    省掉一次哈希查找。
 * 3. **`query` 写进复用缓冲区**并返回它，不分配新数组。代价是调用方必须在
 *    下一次 `query` 之前把结果用完——这一条写在方法注释里。
 *
 * 大世界：表是稀疏的，占用只和**这一帧真的塞进来的 agent 数**成正比，与世界
 * 面积无关；键的打包范围是 ±2²⁴ 格（格边长 2 米时 ≈ ±3.3×10⁷ 米），远超任何
 * 可达坐标，所以不需要跟着世界原点平移。
 */

/** 键打包：格坐标先抬正再乘一个比范围大的因子，两个轴不会串味。 */
const KEY_OFFSET = 1 << 24;
const KEY_STRIDE = 1 << 25;

export class AgentSpatialHash {
  /**
   * @param {number} cellSize 分桶边长，米。取典型查询半径最省——格太小要扫很多
   *   空桶，格太大每个桶里都是远处的人。
   */
  constructor(cellSize) {
    this.setCellSize(cellSize);
    /** @type {Map<number, number[]>} 桶 → 该桶里 agent 的下标。桶数组跨帧复用。 */
    this.cells = new Map();
    /** 建表时的位置快照。避障读它而不是读实时坐标，见 `LocalAvoidance` 的说明。 */
    this.snapshotX = [];
    this.snapshotZ = [];
    this.count = 0;
    /** `query` 的复用缓冲区。 */
    this.buffer = [];
  }

  setCellSize(cellSize) {
    const size = Number(cellSize);
    this.cellSize = Number.isFinite(size) && size > 0 ? size : 1;
    this.inverseCellSize = 1 / this.cellSize;
  }

  /** 桶清空但不丢弃：下一帧多半还是这些桶，重新分配数组只是白花钱。 */
  clear() {
    for (const bucket of this.cells.values()) bucket.length = 0;
    this.count = 0;
  }

  /**
   * 用一帧的 agent 位置重建表。
   *
   * @param {ArrayLike<{ x: number, z: number }>} agents
   * @param {number} [count] 只取前 count 个（数组按容量复用时用得上）
   */
  build(agents, count = agents.length) {
    this.clear();
    const total = Math.max(0, Math.min(count, agents.length));
    this.count = total;
    this.snapshotX.length = total;
    this.snapshotZ.length = total;
    for (let index = 0; index < total; index += 1) {
      const agent = agents[index];
      const x = agent.x;
      const z = agent.z;
      this.snapshotX[index] = x;
      this.snapshotZ[index] = z;
      const key = this.keyOf(Math.floor(x * this.inverseCellSize), Math.floor(z * this.inverseCellSize));
      let bucket = this.cells.get(key);
      if (!bucket) {
        bucket = [];
        this.cells.set(key, bucket);
      }
      bucket.push(index);
    }
  }

  keyOf(cellX, cellZ) {
    return (cellX + KEY_OFFSET) * KEY_STRIDE + (cellZ + KEY_OFFSET);
  }

  /**
   * 半径内的 agent 下标。
   *
   * **返回的是复用缓冲区**：调用方要在发起下一次 `query` 之前消费完，别存起来。
   * 筛选用的是建表时的快照坐标，所以同一帧里问两次得到的答案一样——避障的
   * 正确性依赖这一点。
   *
   * @returns {number[]}
   */
  query(x, z, radius) {
    const { buffer, cells, snapshotX, snapshotZ, inverseCellSize } = this;
    buffer.length = 0;
    if (this.count === 0) return buffer;
    const cellRadius = Math.ceil(radius * inverseCellSize);
    const centerX = Math.floor(x * inverseCellSize);
    const centerZ = Math.floor(z * inverseCellSize);
    const radiusSquared = radius * radius;
    for (let offsetZ = -cellRadius; offsetZ <= cellRadius; offsetZ += 1) {
      const row = centerZ + offsetZ + KEY_OFFSET;
      for (let offsetX = -cellRadius; offsetX <= cellRadius; offsetX += 1) {
        const bucket = cells.get((centerX + offsetX + KEY_OFFSET) * KEY_STRIDE + row);
        if (!bucket) continue;
        for (let slot = 0; slot < bucket.length; slot += 1) {
          const index = bucket[slot];
          const dx = snapshotX[index] - x;
          const dz = snapshotZ[index] - z;
          if (dx * dx + dz * dz <= radiusSquared) buffer.push(index);
        }
      }
    }
    return buffer;
  }
}
