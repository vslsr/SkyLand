/**
 * A* 本体。
 *
 * 结构照搬 Minecraft 的 `PathFinder`：一个二叉堆开集、一个按下标寻址的节点表、
 * 一个 `maxVisitedNodes` 上限，以及**找不到目标时退回最近的那个节点**。最后一条
 * 是整套寻路在玩法上成立的关键——目标被墙围住时，一只只会「原地不动」的生物
 * 看起来是坏了，而一只走到墙根前停下的生物看起来是被墙拦住了。
 *
 * 三条上限一起构成大世界的成本封顶，缺一条都不成立：
 *
 * - **窗口**：只在 `NavRegion` 的 `(2r+1)²` 格里搜，越界即 BLOCKED。
 * - **节点**：展开数超过 `profile.maxVisitedNodes` 就收工，交出手上最好的那条。
 * - **路径**：留下的节点数封顶，长路走完自然会再寻一次。
 *
 * 所有工作数组在第一次搜索时按窗口大小分配一次，之后靠 stamp 复用；一次搜索
 * 不产生任何临时对象，返回的路径数组是唯一的分配。
 */

import { BinaryHeap } from './BinaryHeap.mjs';
import { NavRegion } from './NavRegion.mjs';
import {
  DEFAULT_NAV_SEARCH_RADIUS_CELLS,
  MAX_NAV_PATH_NODES,
  MAX_NAV_SEARCH_RADIUS_CELLS,
  NAV_CELL_SIZE,
  NAV_NODE,
  navCellCenter,
  navMalusOf,
} from './navConfig.mjs';
import { navEdgeBlocked } from './navNodeEvaluator.mjs';

const SQRT2 = Math.SQRT2;
/** 每米高差折算成多少米路程。抬腿和下坎都要花力气，平路优先于上下折腾。 */
const CLIMB_COST_PER_METER = 1;
const HEIGHT_EPSILON = 1e-6;

/** 八向邻居。前四个是正交，后四个是斜向——顺序被拐角规则依赖。 */
const NEIGHBOR_OFFSETS = Object.freeze([
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
]);

function octileDistance(fromCellX, fromCellZ, toCellX, toCellZ) {
  const deltaX = Math.abs(toCellX - fromCellX);
  const deltaZ = Math.abs(toCellZ - fromCellZ);
  const diagonal = Math.min(deltaX, deltaZ);
  return (deltaX + deltaZ - 2 * diagonal + SQRT2 * diagonal) * NAV_CELL_SIZE;
}

/**
 * @typedef {object} NavPathNode
 * @property {number} cellX
 * @property {number} cellZ
 * @property {number} x 格心世界坐标
 * @property {number} z
 * @property {number} y 决策高度，不是最终落地高度
 * @property {number} type NAV_NODE
 */

/**
 * @typedef {object} NavPathResult
 * @property {NavPathNode[]} nodes 从起点格开始；长度为 0 表示连站的地方都没有
 * @property {boolean} reachedGoal 是不是真的走到了目标格
 * @property {number} visitedNodes 展开过的节点数，用于预算统计
 * @property {boolean} truncated 路径是否因为节点上限被截断
 */

export class NavPathfinder {
  /**
   * @param {{ radiusCells?: number }} [options]
   */
  constructor(options = {}) {
    const requested = Math.round(Number(options.radiusCells) || DEFAULT_NAV_SEARCH_RADIUS_CELLS);
    this.radiusCells = Math.max(1, Math.min(MAX_NAV_SEARCH_RADIUS_CELLS, requested));
    /** 工作数组按需分配：一张没有会寻路的 Actor 的地图一个字节都不占。 */
    this.region = undefined;
    this.stamp = 0;
  }

  /** 已分配的窗口格数；0 表示还没有人寻过路。测试用它断言内存上界。 */
  get allocatedCells() {
    return this.region ? this.region.cellCount : 0;
  }

  allocate() {
    if (this.region) return;
    this.region = new NavRegion({ radiusCells: this.radiusCells });
    const cells = this.region.cellCount;
    this.gScore = new Float64Array(cells);
    this.heuristic = new Float64Array(cells);
    this.cameFrom = new Int32Array(cells);
    this.visited = new Int32Array(cells);
    this.closed = new Int32Array(cells);
    this.heap = new BinaryHeap(cells);
  }

  /**
   * 从 `start` 格找一条到 `goal` 格的路。
   *
   * @param {import('./navNodeEvaluator.mjs').NavigationContext} context
   * @param {import('./NavProfile.mjs').NavProfile} profile
   * @param {{ cellX: number, cellZ: number }} start
   * @param {{ cellX: number, cellZ: number }} goal
   * @param {{ goalRadiusCells?: number }} [options]
   * @returns {NavPathResult}
   */
  findPath(context, profile, start, goal, options = {}) {
    this.allocate();
    const region = this.region;
    region.prepare(context, profile, start.cellX, start.cellZ);
    // stamp 走到头就整片归零。和 NavRegion 里那一句同一个理由。
    if (this.stamp >= 0x7fff_ffff) {
      this.visited.fill(0);
      this.closed.fill(0);
      this.stamp = 0;
    }
    this.stamp += 1;
    this.heap.clear();

    const goalRadiusCells = Math.max(0, Math.floor(Number(options.goalRadiusCells) || 0));
    // 体型自带的搜索半径可以比窗口小，但不能比窗口大——窗口是硬边界。
    const searchRadius = Math.min(profile.searchRadiusCells, region.radiusCells);
    const startIndex = region.indexOf(start.cellX, start.cellZ);
    const empty = { nodes: [], reachedGoal: false, visitedNodes: 0, truncated: false };
    if (startIndex < 0) return empty;
    // 起点站不住就没有路可走。**不**在这里帮它找一个附近的落脚点：那是「被卡住了
    // 怎么办」的问题，归跟随那一层（它会请求重寻路并原地挪一步），寻路这一层
    // 如果替它挪，路径的第一个节点就会和它实际所在的位置对不上。
    if (navMalusOf(profile.malus, region.typeAtIndex(startIndex)) < 0) return empty;

    this.gScore[startIndex] = 0;
    this.heuristic[startIndex] = octileDistance(start.cellX, start.cellZ, goal.cellX, goal.cellZ);
    this.cameFrom[startIndex] = -1;
    this.visited[startIndex] = this.stamp;
    this.heap.push(startIndex, this.heuristic[startIndex]);

    let bestIndex = startIndex;
    let bestHeuristic = this.heuristic[startIndex];
    let visitedNodes = 0;
    let goalIndex = -1;

    while (!this.heap.isEmpty) {
      const current = this.heap.pop();
      if (this.closed[current] === this.stamp) continue;
      this.closed[current] = this.stamp;
      visitedNodes += 1;

      const currentCellX = region.cellXOf(current);
      const currentCellZ = region.cellZOf(current);
      const reached = Math.max(
        Math.abs(currentCellX - goal.cellX),
        Math.abs(currentCellZ - goal.cellZ),
      ) <= goalRadiusCells;
      if (reached) {
        goalIndex = current;
        break;
      }
      // 展开预算用完就收工。手上那条通往最近点的路仍然是有用的一步——
      // 走过去之后再想一次，下一次的窗口已经挪到了新位置。
      if (visitedNodes >= profile.maxVisitedNodes) break;

      const currentStandY = region.standYAtIndex(current);
      const currentG = this.gScore[current];

      for (let direction = 0; direction < NEIGHBOR_OFFSETS.length; direction += 1) {
        const [deltaX, deltaZ] = NEIGHBOR_OFFSETS[direction];
        const neighborCellX = currentCellX + deltaX;
        const neighborCellZ = currentCellZ + deltaZ;
        if (Math.max(
          Math.abs(neighborCellX - start.cellX),
          Math.abs(neighborCellZ - start.cellZ),
        ) > searchRadius) continue;
        const neighbor = region.indexOf(neighborCellX, neighborCellZ);
        if (neighbor < 0 || this.closed[neighbor] === this.stamp) continue;

        const neighborType = region.typeAtIndex(neighbor);
        const malus = navMalusOf(profile.malus, neighborType);
        if (malus < 0) continue;

        const neighborStandY = region.standYAtIndex(neighbor);
        const climb = neighborStandY - currentStandY;
        if (climb > profile.stepUp + HEIGHT_EPSILON) continue;
        if (-climb > profile.maxDrop + HEIGHT_EPSILON) continue;

        const diagonal = deltaX !== 0 && deltaZ !== 0;
        if (diagonal) {
          if (!this.canCutCorner(
            context,
            profile,
            currentCellX,
            currentCellZ,
            neighborCellX,
            neighborCellZ,
          )) continue;
        } else if (navEdgeBlocked(context, currentCellX, currentCellZ, neighborCellX, neighborCellZ)) {
          continue;
        }

        const stepDistance = (diagonal ? SQRT2 : 1) * NAV_CELL_SIZE;
        const tentative = currentG
          + stepDistance * (1 + malus)
          + Math.abs(climb) * CLIMB_COST_PER_METER;
        if (this.visited[neighbor] === this.stamp && tentative >= this.gScore[neighbor]) continue;

        this.visited[neighbor] = this.stamp;
        this.gScore[neighbor] = tentative;
        this.cameFrom[neighbor] = current;
        const remaining = octileDistance(neighborCellX, neighborCellZ, goal.cellX, goal.cellZ);
        this.heuristic[neighbor] = remaining;
        this.heap.push(neighbor, tentative + remaining);
        // 最近点：先比离目标多远，一样远时比已经走了多少——这样退回来的那条路
        // 是「离目标最近，且到得最省」的那一个落脚点。
        if (remaining < bestHeuristic
          || (remaining === bestHeuristic && tentative < this.gScore[bestIndex])) {
          bestHeuristic = remaining;
          bestIndex = neighbor;
        }
      }
    }

    const endIndex = goalIndex >= 0 ? goalIndex : bestIndex;
    const nodes = this.reconstruct(endIndex);
    return {
      nodes: nodes.nodes,
      reachedGoal: goalIndex >= 0,
      visitedNodes,
      truncated: nodes.truncated,
    };
  }

  /**
   * 斜着穿过一个格角允不允许。
   *
   * 两个中间格都要站得住，四条被蹭到的边上都不能有墙。少判一条边，AI 就会从
   * 一堵墙和一个树干之间的缝里斜插过去——那是玩家看得见的穿模。
   */
  canCutCorner(context, profile, fromCellX, fromCellZ, toCellX, toCellZ) {
    const region = this.region;
    const sideA = region.typeAt(toCellX, fromCellZ);
    const sideB = region.typeAt(fromCellX, toCellZ);
    if (navMalusOf(profile.malus, sideA) < 0) return false;
    if (navMalusOf(profile.malus, sideB) < 0) return false;
    if (navEdgeBlocked(context, fromCellX, fromCellZ, toCellX, fromCellZ)) return false;
    if (navEdgeBlocked(context, fromCellX, fromCellZ, fromCellX, toCellZ)) return false;
    if (navEdgeBlocked(context, toCellX, fromCellZ, toCellX, toCellZ)) return false;
    if (navEdgeBlocked(context, fromCellX, toCellZ, toCellX, toCellZ)) return false;
    return true;
  }

  /** 顺着 cameFrom 回溯成一条从起点开始的路；超长时截掉尾巴，保留前面那段。 */
  reconstruct(endIndex) {
    const region = this.region;
    const reversed = [];
    let index = endIndex;
    // 回溯步数按窗口格数封顶：即使 cameFrom 因为 bug 成了环，这里也会停下来。
    let guard = region.cellCount + 1;
    while (index >= 0 && guard > 0) {
      guard -= 1;
      reversed.push(index);
      index = this.cameFrom[index];
    }
    const truncated = reversed.length > MAX_NAV_PATH_NODES;
    const total = truncated ? MAX_NAV_PATH_NODES : reversed.length;
    const nodes = new Array(total);
    for (let position = 0; position < total; position += 1) {
      const nodeIndex = reversed[reversed.length - 1 - position];
      const cellX = region.cellXOf(nodeIndex);
      const cellZ = region.cellZOf(nodeIndex);
      nodes[position] = {
        cellX,
        cellZ,
        x: navCellCenter(cellX),
        z: navCellCenter(cellZ),
        y: region.standYAtIndex(nodeIndex),
        type: region.typeAtIndex(nodeIndex),
      };
    }
    return { nodes, truncated };
  }
}

export { NAV_NODE };
