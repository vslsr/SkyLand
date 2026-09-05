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
 */

export { BinaryHeap } from './BinaryHeap.mjs';
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
export { classifyNavCell, createNavigationContext, navEdgeBlocked } from './navNodeEvaluator.mjs';
export { navLineWalkable, smoothNavPath } from './smoothNavPath.mjs';
