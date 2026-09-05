/**
 * 拉绳平滑：把 A* 交出来的锯齿路径拉直。
 *
 * 格子上的 A* 只会给出八个方向，一条斜着穿过空地的路会走成楼梯。玩家看到的
 * 不是「最优路径」，是一只走路一抽一抽的生物。平滑做的事只有一件：**能直着
 * 走过去的两个节点之间，中间的节点全部删掉。**
 *
 * 「能直着走过去」用的是和 A* 完全相同的判据——逐格步进，每一步都问同样的
 * 三个问题（这一格站不站得住、这条边上有没有墙、这一步的高差能不能接受）。
 * 判据分成两套的话，平滑会把 AI 送进一条 A* 明确拒绝过的路，而那条路上有
 * 一堵墙。
 *
 * 向前看的距离有上限：拉绳本身是 O(节点数 × 前瞻 × 段长)，不封顶的话一条
 * 长路的平滑会比寻它还贵。
 */

import { NAV_CELL_SIZE, navCellCenter, navMalusOf } from './navConfig.mjs';
import { navEdgeBlocked } from './navNodeEvaluator.mjs';

/** 最多往前看多少个节点。够拉直一条常见的楼梯，又不会让长路径退化成 O(n²)。 */
const MAX_SMOOTH_LOOKAHEAD = 12;
const HEIGHT_EPSILON = 1e-6;

/**
 * 从一格直走到另一格，中途会不会撞上什么。
 *
 * 逐格步进用的是标准的网格穿越（Amanatides–Woo）：沿着两个格心之间的线段
 * 推进，每次跨过一条格线就换一格。正对着角点的那一步会同时跨两条线，这时
 * 按「先 X 后 Z」拆成两步分别检查——直接斜跨过去就等于绕开了拐角规则。
 */
export function navLineWalkable(region, context, profile, fromCellX, fromCellZ, toCellX, toCellZ) {
  if (fromCellX === toCellX && fromCellZ === toCellZ) return true;
  const startX = navCellCenter(fromCellX);
  const startZ = navCellCenter(fromCellZ);
  const endX = navCellCenter(toCellX);
  const endZ = navCellCenter(toCellZ);
  const directionX = endX - startX;
  const directionZ = endZ - startZ;
  const stepX = Math.sign(directionX);
  const stepZ = Math.sign(directionZ);
  // 到下一条格线还差多少个 t（t ∈ [0, 1] 是线段参数）。步长为 0 的轴永远不跨线。
  const deltaX = stepX === 0 ? Infinity : NAV_CELL_SIZE / Math.abs(directionX);
  const deltaZ = stepZ === 0 ? Infinity : NAV_CELL_SIZE / Math.abs(directionZ);
  // 两个端点都是格心，所以第一条格线永远在半格处。
  let nextX = stepX === 0 ? Infinity : deltaX * 0.5;
  let nextZ = stepZ === 0 ? Infinity : deltaZ * 0.5;

  let cellX = fromCellX;
  let cellZ = fromCellZ;
  let standY = region.standYAt(cellX, cellZ);
  // 步数上界：曼哈顿距离就是要跨的格线总数，多一步都不该有。
  let guard = Math.abs(toCellX - fromCellX) + Math.abs(toCellZ - fromCellZ) + 1;
  while ((cellX !== toCellX || cellZ !== toCellZ) && guard > 0) {
    guard -= 1;
    let advanceX = false;
    let advanceZ = false;
    if (nextX < nextZ - 1e-9) advanceX = true;
    else if (nextZ < nextX - 1e-9) advanceZ = true;
    else {
      // 正对角：拆成两步走，两步都要各自过关。
      advanceX = true;
      advanceZ = true;
    }

    if (advanceX) {
      const nextCellX = cellX + stepX;
      if (!stepAllowed(region, context, profile, cellX, cellZ, nextCellX, cellZ, standY)) return false;
      standY = region.standYAt(nextCellX, cellZ);
      cellX = nextCellX;
      nextX += deltaX;
    }
    if (advanceZ) {
      const nextCellZ = cellZ + stepZ;
      if (!stepAllowed(region, context, profile, cellX, cellZ, cellX, nextCellZ, standY)) return false;
      standY = region.standYAt(cellX, nextCellZ);
      cellZ = nextCellZ;
      nextZ += deltaZ;
    }
  }
  return cellX === toCellX && cellZ === toCellZ;
}

function stepAllowed(region, context, profile, fromCellX, fromCellZ, toCellX, toCellZ, standY) {
  if (navMalusOf(profile.malus, region.typeAt(toCellX, toCellZ)) < 0) return false;
  if (navEdgeBlocked(context, fromCellX, fromCellZ, toCellX, toCellZ)) return false;
  const climb = region.standYAt(toCellX, toCellZ) - standY;
  if (climb > profile.stepUp + HEIGHT_EPSILON) return false;
  if (-climb > profile.maxDrop + HEIGHT_EPSILON) return false;
  return true;
}

/**
 * 删掉能被直线跨过的中间节点。返回一个新数组，原路径不动。
 *
 * @param {import('./NavRegion.mjs').NavRegion} region 刚做完这次搜索的窗口，分类已在缓存里
 * @param {import('./navNodeEvaluator.mjs').NavigationContext} context
 * @param {import('./NavProfile.mjs').NavProfile} profile
 * @param {import('./NavPathfinder.mjs').NavPathNode[]} nodes
 */
export function smoothNavPath(region, context, profile, nodes) {
  if (!Array.isArray(nodes) || nodes.length <= 2) return Array.isArray(nodes) ? nodes.slice() : [];
  const result = [nodes[0]];
  let anchor = 0;
  while (anchor < nodes.length - 1) {
    const limit = Math.min(nodes.length - 1, anchor + MAX_SMOOTH_LOOKAHEAD);
    let next = anchor + 1;
    for (let candidate = limit; candidate > anchor + 1; candidate -= 1) {
      if (navLineWalkable(
        region,
        context,
        profile,
        nodes[anchor].cellX,
        nodes[anchor].cellZ,
        nodes[candidate].cellX,
        nodes[candidate].cellZ,
      )) {
        next = candidate;
        break;
      }
    }
    result.push(nodes[next]);
    anchor = next;
  }
  return result;
}
