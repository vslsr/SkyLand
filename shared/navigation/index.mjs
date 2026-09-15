/**
 * AI 寻路。公开入口只有这一处，内部文件之间的引用不算公开接口。
 *
 * 分层与 Minecraft 一一对应：
 *
 * | SkyLand | Minecraft | 职责 |
 * | --- | --- | --- |
 * | `navNodeEvaluator.mjs` | `WalkNodeEvaluator` | 一格是什么、站多高、边上有没有墙 |
 * | `NavRegion.mjs` | `PathNavigationRegion` | 只覆盖搜索窗口的世界快照 |
 * | `NavPathfinder.mjs` | `PathFinder` + `BinaryHeap` | A*、节点预算、最近点回退 |
 * | `smoothNavPath.mjs` | （无） | 拉绳平滑，把楼梯拉成直线 |
 * | `NavigationComponent` | `PathNavigation` | 跟着路走、什么时候重寻、卡住了怎么办 |
 *
 * 还有一层是 Minecraft 没有的：`LocalAvoidance`（局部避障 / RVO）。搜索认识静态
 * 世界，它认识**别的会走路的生物**——两只沿同一条路走的生物各自的路都是最优的，
 * 走起来却是一只顶着另一只。它只改这一步的方向，不改路；理由写在
 * `avoidanceConfig.mjs` 顶上。
 */

export { AgentSpatialHash } from './AgentSpatialHash.mjs';
export { BinaryHeap } from './BinaryHeap.mjs';
export { LocalAvoidance } from './LocalAvoidance.mjs';
export { NavPathfinder } from './NavPathfinder.mjs';
export { NavRegion } from './NavRegion.mjs';
export { createNavProfile, navProfileClassifiesAlike } from './NavProfile.mjs';
export {
  DEFAULT_NAV_MALUS,
  DEFAULT_NAV_SEARCH_RADIUS_CELLS,
  DEFAULT_NAV_VISITED_NODES,
  MAX_NAV_MALUS,
  MAX_NAV_PATH_NODES,
  MAX_NAV_SEARCH_RADIUS_CELLS,
  MAX_NAV_VISITED_NODES,
  NAV_CELL_SIZE,
  NAV_NODE,
  NAV_NODE_COUNT,
  isNavTypePassable,
  navCellCenter,
  navMalusOf,
  toNavCell,
} from './navConfig.mjs';
export { DEFAULT_AVOIDANCE, createAvoidanceConfig } from './avoidanceConfig.mjs';
export { classifyNavCell, createNavigationContext, navEdgeBlocked } from './navNodeEvaluator.mjs';
export { navLineWalkable, smoothNavPath } from './smoothNavPath.mjs';
