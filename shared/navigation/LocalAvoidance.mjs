/**
 * 局部避障：一群会走路的 agent 互相让路。
 *
 * 每 tick 做两件事——先把这一帧所有 agent 的位置塞进空间哈希（`beginFrame`），
 * 再逐只问「照着路我该往这边走，考虑到旁边这些人，实际该往哪边走」（`steer`）。
 * 它**不改路**：产出永远是一个单位方向，位移大小仍由调用方按自己的速度决定。
 * 分工的理由写在 `avoidanceConfig.mjs` 顶上。
 *
 * ## 两个力
 *
 * **径向分离力**把邻居推开，越近越强（平方衰减）。它单独用是不够的：正前方的
 * 邻居产生的斥力与前进方向恰好反向，合力永远落在同一条直线上，于是一只生物会
 * 顶着挡路者原地不动——这是一个稳定的死结，不是抖动，等多久都不会自己解开。
 *
 * **切向绕行力**垂直于前进方向，只由「挡在正前方通行走廊里」的邻居产生，
 * 让生物从旁边滑过去。选边必须是**确定的**：服务端是权威，随机方向不可复现；
 * 而且迎面相遇的两只若各自随机选边，有一半概率选到同一侧，贴上再弹开、来回跳舞。
 * 这里用交通规则式的固定手性——挡路者在我左边就往右让，正对着时全场统一往同
 * 一侧让（迎面双方朝向相反，「同一侧」在世界坐标里正好是相反方向，自然错开）。
 *
 * ## 为什么读快照而不是实时坐标
 *
 * 一帧之内所有人看到的是**同一张**位置表（`beginFrame` 建表时的快照），先算的
 * 那只不会看到后算的那只已经挪过的位置。读实时坐标的话，结果取决于遍历顺序，
 * 同样的局面换个数组顺序就是另一个答案——服务端是权威，这种不可复现的分歧最后
 * 会变成客户端与服务端对不上的位置。
 *
 * ## 大世界
 *
 * 成本只和**这一帧传进来的 agent 数**成正比，与世界面积无关：调用方负责只把
 * 活跃窗口内的 agent 传进来（`NavigationSystem` 传的是带 `navigation` 的 Actor）。
 * 每只的邻居数由 `maxNeighbors` 封顶，所以密集人群里也是 O(n·K) 而不是 O(n²)。
 */

import { AgentSpatialHash } from './AgentSpatialHash.mjs';
import { createAvoidanceConfig } from './avoidanceConfig.mjs';

/** 黄金角。重合时用它按下标散开，稳定、可复现、不需要随机数。 */
const GOLDEN_ANGLE = 2.399963229728653;

/**
 * 一个参与避障的 agent。调用方每帧填好这些字段传进来；这一层不认识 Actor。
 *
 * @typedef {object} AvoidanceAgent
 * @property {number} x
 * @property {number} z
 * @property {number} radius 圆形足迹半径，米
 * @property {number} speed 这一刻的行进速度，米每秒。决定预测窗口看多远
 * @property {boolean} moving 正不正被推着走。站着不动的挡路者不会让路，避让责任全在对方
 * @property {number} goalDistance 离自己目标还有多远，米。没有目标写 Infinity
 * @property {boolean} [avoids] 自己要不要避让别人。false 的仍然是别人的障碍
 */

export class LocalAvoidance {
  /**
   * @param {Partial<import('./avoidanceConfig.mjs').AvoidanceConfig> & { hashCellSize?: number }} [options]
   */
  constructor(options = {}) {
    this.config = createAvoidanceConfig(options);
    // 分桶边长取一个典型查询半径。传进来的 agent 体型差得远时它只影响常数，
    // 不影响答案——`query` 会按真实半径决定扫几圈桶。
    const hashCellSize = Number(options.hashCellSize);
    this.hash = new AgentSpatialHash(Number.isFinite(hashCellSize) && hashCellSize > 0 ? hashCellSize : 2);
    /** @type {ArrayLike<AvoidanceAgent>} */
    this.agents = [];
    this.count = 0;
    // K-nearest 的定长缓冲区：整个生命周期只分配这一次。
    this.neighborDistance = new Float64Array(this.config.maxNeighbors);
    this.neighborIndex = new Int32Array(this.config.maxNeighbors);
    this.neighborCount = 0;
    /** 重合的邻居直接产生的推力，不进 K-nearest（见 `gather`）。 */
    this.overlapX = 0;
    this.overlapZ = 0;
    /** @type {((self: AvoidanceAgent, other: AvoidanceAgent) => boolean) | undefined} */
    this.filter = undefined;
    if (typeof options.filter === 'function') this.filter = options.filter;
  }

  /**
   * 收下这一帧的 agent 并建表。数组由调用方持有并复用，这里不拷贝。
   *
   * @param {ArrayLike<AvoidanceAgent>} agents
   * @param {number} [count] 只取前 count 个
   */
  beginFrame(agents, count = agents.length) {
    this.agents = agents;
    this.count = Math.max(0, Math.min(count, agents.length));
    this.hash.build(agents, this.count);
  }

  /**
   * 照着路的方向 `(directionX, directionZ)`（单位向量），算出这一步实际该走的方向。
   *
   * @param {number} index `beginFrame` 里的下标
   * @param {number} directionX
   * @param {number} directionZ
   * @param {{ x: number, z: number, avoided: boolean }} out 复用的输出对象
   */
  steer(index, directionX, directionZ, out = { x: 0, z: 0, avoided: false }) {
    out.x = directionX;
    out.z = directionZ;
    out.avoided = false;
    const self = this.agents[index];
    if (!self || self.avoids === false) return out;
    const gathered = this.gather(index);
    if (gathered === 0 && this.overlapX === 0 && this.overlapZ === 0) return out;

    const config = this.config;
    const radius = self.radius;
    const separationRadius = this.separationRadiusOf(self);
    const goalDistance = Number.isFinite(self.goalDistance) ? self.goalDistance : Infinity;
    // 垂直于前进方向的那一侧。切向力只会落在这条轴上。
    const perpendicularX = -directionZ;
    const perpendicularZ = directionX;
    const headOnEpsilon = radius * config.headOnEpsilonScale;

    let separationX = this.overlapX;
    let separationZ = this.overlapZ;
    let tangentX = 0;
    let tangentZ = 0;

    for (let slot = 0; slot < gathered; slot += 1) {
      const other = this.agents[this.neighborIndex[slot]];
      const distance = this.neighborDistance[slot];
      const awayX = self.x - other.x;
      const awayZ = self.z - other.z;
      const falloff = 1 - distance / separationRadius;
      const push = falloff * falloff;
      separationX += (awayX / distance) * push;
      separationZ += (awayZ / distance) * push;

      // —— 切向绕行：只有「在我前方 + 落在通行走廊里」的邻居才算挡路 ——
      const towardX = -awayX;
      const towardZ = -awayZ;
      const along = towardX * directionX + towardZ * directionZ;
      if (along <= 0) continue; // 在身后：推开就够了，不需要绕
      // **落在目的地上（或更远）的邻居不是障碍，它就是目的地**。追人的生物的
      // 目标点就是那个人本体，绕开它等于绕着人转圈永远追不上。只绕「路当中」的。
      if (along >= goalDistance - (radius + other.radius)) continue;
      const side = towardX * perpendicularX + towardZ * perpendicularZ;
      const corridor = radius + other.radius + radius * config.corridorPadScale;
      if (side >= corridor || side <= -corridor) continue; // 侧面错得开，不用绕
      // 正对着时统一往 -perpendicular 让；否则往「邻居所在的反侧」让。
      const sign = side > headOnEpsilon ? -1 : side < -headOnEpsilon ? 1 : -1;
      // 越正对（|side| 越小）、越近，绕行需求越强。
      const headOn = 1 - Math.abs(side) / corridor;
      const boost = other.moving ? 1 : config.staticBoost;
      const weight = push * headOn * boost * sign;
      tangentX += perpendicularX * weight;
      tangentZ += perpendicularZ * weight;
    }

    // 合成时**不归一化分离力**：邻居越多越近，合力越大，于是拥挤处「别挤」自然
    // 压过「往前走」，空旷处几乎不起作用。先归一化就把这个自适应抹掉了。
    const mixX = directionX + separationX * config.separationWeight + tangentX * config.tangentWeight;
    const mixZ = directionZ + separationZ * config.separationWeight + tangentZ * config.tangentWeight;
    const length = Math.hypot(mixX, mixZ);
    if (length < 1e-9) return out; // 力正好抵消：保持原方向，别把自己钉在原地
    out.x = mixX / length;
    out.z = mixZ / length;
    out.avoided = true;
    return out;
  }

  /**
   * 站定时的互相推开。
   *
   * 追到同一个目标面前停下的几只会重叠成一坨，而它们这时手上都没有路，
   * `steer` 根本不会被调用。只算真正**重叠**的那部分：站得开的不该被推。
   *
   * @param {number} index
   * @param {{ x: number, z: number, strength: number }} out
   * @returns {{ x: number, z: number, strength: number }} 单位方向 + [0,1] 的拥挤程度
   */
  separate(index, out = { x: 0, z: 0, strength: 0 }) {
    out.x = 0;
    out.z = 0;
    out.strength = 0;
    const self = this.agents[index];
    if (!self || self.avoids === false) return out;
    const gathered = this.gather(index);
    let pushX = this.overlapX;
    let pushZ = this.overlapZ;
    let crowding = this.overlapX !== 0 || this.overlapZ !== 0 ? 1 : 0;
    for (let slot = 0; slot < gathered; slot += 1) {
      const other = this.agents[this.neighborIndex[slot]];
      const distance = this.neighborDistance[slot];
      const contact = self.radius + other.radius;
      if (distance >= contact) continue;
      const overlap = 1 - distance / contact;
      pushX += ((self.x - other.x) / distance) * overlap;
      pushZ += ((self.z - other.z) / distance) * overlap;
      if (overlap > crowding) crowding = overlap;
    }
    const length = Math.hypot(pushX, pushZ);
    if (length < 1e-9) return out;
    out.x = pushX / length;
    out.z = pushZ / length;
    out.strength = Math.min(1, crowding);
    return out;
  }

  /** 这只这一刻的分离力作用半径：体型与「预测窗口里能走多远」取大。 */
  separationRadiusOf(agent) {
    const speed = Number.isFinite(agent.speed) ? Math.max(0, agent.speed) : 0;
    return Math.max(
      agent.radius * this.config.separationRadiusScale,
      speed * this.config.timeHorizonSeconds,
    );
  }

  /**
   * 挑出最近的 K 个邻居，写进定长缓冲区。
   *
   * 固定大小的 max-slot 线性扫描，不排序也不分配：K 是 6，线性扫比堆快，而且
   * 分支预测友好。完全重合（距离为 0）的不占 K 的名额，直接累进 `overlapX/Z`——
   * 它没有方向可言，却是最该被推开的一种，让它去和别人抢名额就本末倒置了。
   *
   * @returns {number} 真的挑出了几个
   */
  gather(index) {
    this.neighborCount = 0;
    this.overlapX = 0;
    this.overlapZ = 0;
    const self = this.agents[index];
    if (!self) return 0;
    const separationRadius = this.separationRadiusOf(self);
    const searchRadius = Math.max(separationRadius, self.radius * this.config.neighborRadiusScale);
    const candidates = this.hash.query(self.x, self.z, searchRadius);
    const distances = this.neighborDistance;
    const indices = this.neighborIndex;
    const limit = this.config.maxNeighbors;
    let gathered = 0;
    let worstDistance = 0;
    let worstSlot = 0;
    for (let slot = 0; slot < candidates.length; slot += 1) {
      const candidate = candidates[slot];
      if (candidate === index) continue;
      const other = this.agents[candidate];
      if (this.filter && !this.filter(self, other)) continue;
      const dx = self.x - other.x;
      const dz = self.z - other.z;
      const distanceSquared = dx * dx + dz * dz;
      if (distanceSquared === 0) {
        // 完全重合：没有方向可推，按下标取一个稳定的伪随机方向散开。
        const angle = (index + 1) * GOLDEN_ANGLE;
        this.overlapX += Math.cos(angle);
        this.overlapZ += Math.sin(angle);
        continue;
      }
      const distance = Math.sqrt(distanceSquared);
      if (distance >= separationRadius) continue;
      if (gathered < limit) {
        distances[gathered] = distance;
        indices[gathered] = candidate;
        if (distance > worstDistance) {
          worstDistance = distance;
          worstSlot = gathered;
        }
        gathered += 1;
      } else if (distance < worstDistance) {
        distances[worstSlot] = distance;
        indices[worstSlot] = candidate;
        worstDistance = 0;
        for (let k = 0; k < limit; k += 1) {
          if (distances[k] > worstDistance) {
            worstDistance = distances[k];
            worstSlot = k;
          }
        }
      }
    }
    this.neighborCount = gathered;
    return gathered;
  }

  /**
   * 谁该躲谁的过滤器。写了它就能让一队人马穿过自己人只躲敌人，或让幽灵谁也不躲。
   *
   * @param {((self: AvoidanceAgent, other: AvoidanceAgent) => boolean) | undefined} filter
   */
  setFilter(filter) {
    this.filter = typeof filter === 'function' ? filter : undefined;
  }
}
