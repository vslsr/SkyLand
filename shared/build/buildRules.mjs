import {
  cellNeighbors,
  edgeCells,
  isHullCell,
  isWithinHullExtent,
  siteSlotOf,
} from './buildGrid.mjs';

/**
 * 建造规则：一个放置位到底能不能放。
 *
 * 客户端和服务端调的是同一个函数——客户端拿它给幽灵判红绿并出提示，服务端拿它
 * 做最终裁决。两端喂进来的上下文不一样（客户端是快照里的镜像，服务端是权威状态），
 * 规则本身只有这一份，所以「幽灵是绿的却被拒」这类漂移只可能来自状态不同步，
 * 不会来自两边各写了一套判断。
 *
 * 规则来自设计稿（doc/desinger-buildsys.md），topdown 视角没有天花板，所以没有
 * 「叠一层」：
 *
 * - 件只能放在自己声明的表面上：水上件上船，静态件落地，物件两边都行；
 * - 够得着：以权威角色位置到放置位的水平距离算，上限来自件的原型；
 * - 一格一块地基、一边一面墙、一格里每种物件槽一件；
 * - **水上地基**：没有船时要放在水里，这就立起一艘新船；有船时要挨着已有甲板，
 *   且不超出那艘船的扩建范围；
 * - **静态地基**：放在陆地格或河床格的中心，整格落在活动范围内；
 * - **墙**：两侧至少一侧有地基撑着；静态墙也可以直接立在地形格（含河床格）的边上；
 * - **物件**：放在地基上，静态的还可以直接放在陆地格中心；
 * - 实体碰撞：放置位不能和玩家、掉落物、场景物件重叠——同一表面上已有的建造件
 *   不算，它们之间靠占位槽互斥；
 * - 建造件有预算：每人、每艘船、每个房间各有上限，快照与碰撞表才不会无界增长；
 * - 材料够：按原型上的 cost 从背包扣，一样不够整件不放。
 *
 * 顺序刻意把材料放最后：幽灵先告诉玩家「这里能不能放」，再告诉他「缺什么」。
 */

export const BUILD_REJECTIONS = Object.freeze({
  SURFACE: 'surface',
  REACH: 'reach',
  OCCUPIED: 'occupied',
  NEEDS_WATER: 'needs-water',
  BOUNDS: 'bounds',
  NO_LAND: 'no-land',
  EXTENT: 'extent',
  SUPPORT: 'support',
  BLOCKED: 'blocked',
  BUDGET: 'budget',
  MATERIALS: 'materials',
});

/** 给界面的提示文案；服务端只用 id。 */
export const BUILD_REJECTION_LABELS = Object.freeze({
  [BUILD_REJECTIONS.SURFACE]: '这件东西不能放在这里',
  [BUILD_REJECTIONS.REACH]: '太远了',
  [BUILD_REJECTIONS.OCCUPIED]: '这里已经有东西了',
  [BUILD_REJECTIONS.NEEDS_WATER]: '水上地基要放在水里',
  [BUILD_REJECTIONS.BOUNDS]: '超出活动范围',
  [BUILD_REJECTIONS.NO_LAND]: '这张地图没有可建的陆地',
  [BUILD_REJECTIONS.EXTENT]: '离船太远了',
  [BUILD_REJECTIONS.SUPPORT]: '下面没有地基撑着',
  [BUILD_REJECTIONS.BLOCKED]: '被人或东西挡住了',
  [BUILD_REJECTIONS.BUDGET]: '建造件已达上限',
  [BUILD_REJECTIONS.MATERIALS]: '材料不够',
});

/** 每人、每个房间的建造件上限。快照、碰撞表和占位表都以它为界。 */
export const MAX_BUILD_PIECES_PER_PLAYER = 64;
export const MAX_BUILD_PIECES_PER_ROOM = 512;

const ok = Object.freeze({ ok: true });
const reject = (reason) => ({ ok: false, reason });

/**
 * 这一格上有没有甲板/地基可以撑东西：船体自带的甲板算，放上去的地基也算。
 *
 * @param {{ hasFoundation(surfaceKey: string, cellX: number, cellZ: number): boolean }} sites
 * @param {{ surface: string, surfaceKey: string | undefined, grid: object }} placementLike
 */
export function hasDeckAt(sites, placementLike, cellX, cellZ) {
  if (placementLike.surface === 'floating' && isHullCell(placementLike.grid, cellX, cellZ)) return true;
  if (placementLike.surfaceKey === undefined) return false;
  return sites.hasFoundation(placementLike.surfaceKey, cellX, cellZ);
}

/**
 * @typedef {object} BuildRuleContext
 * @property {number} distance 发起者到放置位的水平距离
 * @property {boolean} hasLand 这张图有没有可建静态件的地面
 * @property {(cellX: number, cellZ: number) => 'bounds'|'water'|'land'} cellStatus 世界格是什么
 * @property {(surfaceKey: string, cellX: number, cellZ: number, slot: string) => boolean} isOccupied
 * @property {(surfaceKey: string, cellX: number, cellZ: number) => boolean} hasFoundation 只看放上去的件
 * @property {() => boolean} isBlocked 放置位和玩家/掉落物/场景物件重叠；几何规则都过了才问
 * @property {boolean} canAfford
 * @property {boolean} withinBudget
 */

/**
 * @param {import('./buildGrid.mjs').BuildPlacement} placement
 * @param {{ kind: string, surface: string, reach: number, slot?: string, hull?: string }} piece
 * @param {BuildRuleContext} context
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateBuildPlacement(placement, piece, context) {
  if (!placement) return reject(BUILD_REJECTIONS.SURFACE);
  if (piece.surface !== 'any' && placement.surface !== piece.surface) return reject(BUILD_REJECTIONS.SURFACE);
  if (!(context.distance <= piece.reach)) return reject(BUILD_REJECTIONS.REACH);
  const { cellX, cellZ, edge } = placement;
  const slot = siteSlotOf(piece, edge);
  if (placement.surfaceKey !== undefined
    && context.isOccupied(placement.surfaceKey, cellX, cellZ, slot)) {
    return reject(BUILD_REJECTIONS.OCCUPIED);
  }
  const sites = { hasFoundation: context.hasFoundation };
  const deckAt = ([x, z]) => hasDeckAt(sites, placement, x, z);

  if (placement.surface === 'floating') {
    if (placement.founding) {
      // 最初的一块板：要有船的定义，要在水里。
      if (piece.kind !== 'foundation' || !piece.hull || !placement.hullGrid) {
        return reject(BUILD_REJECTIONS.SUPPORT);
      }
      const status = context.cellStatus(cellX, cellZ);
      if (status === 'bounds') return reject(BUILD_REJECTIONS.BOUNDS);
      if (status !== 'water') return reject(BUILD_REJECTIONS.NEEDS_WATER);
    } else if (piece.kind === 'foundation') {
      // 船体自带的格子已经是甲板，不能再铺一层。
      if (isHullCell(placement.grid, cellX, cellZ)) return reject(BUILD_REJECTIONS.OCCUPIED);
      if (!isWithinHullExtent(placement.grid, cellX, cellZ)) return reject(BUILD_REJECTIONS.EXTENT);
      if (!cellNeighbors(cellX, cellZ).some(deckAt)) return reject(BUILD_REJECTIONS.SUPPORT);
    } else if (piece.kind === 'wall') {
      if (!edgeCells(cellX, cellZ, edge).some(deckAt)) return reject(BUILD_REJECTIONS.SUPPORT);
    } else if (!deckAt([cellX, cellZ])) {
      return reject(BUILD_REJECTIONS.SUPPORT);
    }
  } else {
    if (!context.hasLand) return reject(BUILD_REJECTIONS.NO_LAND);
    if (piece.kind === 'foundation') {
      // 陆地格和河床格都行：河床上的地基就是一座码头。
      if (context.cellStatus(cellX, cellZ) === 'bounds') return reject(BUILD_REJECTIONS.BOUNDS);
    } else if (piece.kind === 'wall') {
      // 静态墙可以立在地基边上，也可以直接立在地形格（含河床格）的边上。
      const supported = edgeCells(cellX, cellZ, edge).some(([x, z]) => (
        context.hasFoundation(placement.surfaceKey, x, z) || context.cellStatus(x, z) !== 'bounds'
      ));
      if (!supported) return reject(BUILD_REJECTIONS.BOUNDS);
    } else if (!context.hasFoundation(placement.surfaceKey, cellX, cellZ)) {
      // 物件直接落地只能落在陆地格中心；河床上得先铺地基。
      const status = context.cellStatus(cellX, cellZ);
      if (status === 'bounds') return reject(BUILD_REJECTIONS.BOUNDS);
      if (status !== 'land') return reject(BUILD_REJECTIONS.SUPPORT);
    }
  }

  if (context.isBlocked()) return reject(BUILD_REJECTIONS.BLOCKED);
  if (!context.withinBudget) return reject(BUILD_REJECTIONS.BUDGET);
  if (!context.canAfford) return reject(BUILD_REJECTIONS.MATERIALS);
  return ok;
}

/**
 * 拆除的前置：地基上面还立着墙或摆着物件就不能拆——它们会悬空。
 * 墙的另一侧也有地基撑着时不算依赖。
 *
 * @param {import('./BuildSiteIndex.mjs').BuildSiteRecord} record 要拆的件
 * @param {{ hasFoundation: Function, wallsAround: Function, fixturesAt: Function }} sites
 * @param {{ surface: string, surfaceKey: string, grid: object }} placementLike
 */
export function findDependentPieces(record, sites, placementLike) {
  if (record.kind !== 'foundation') return [];
  const dependents = [];
  for (const wall of sites.wallsAround(record.surfaceKey, record.cellX, record.cellZ)) {
    const otherSupport = edgeCells(wall.cellX, wall.cellZ, wall.edge)
      .filter(([cellX, cellZ]) => cellX !== record.cellX || cellZ !== record.cellZ)
      .some(([cellX, cellZ]) => hasDeckAt(sites, placementLike, cellX, cellZ));
    if (!otherSupport) dependents.push(wall);
  }
  dependents.push(...sites.fixturesAt(record.surfaceKey, record.cellX, record.cellZ));
  return dependents;
}

/**
 * 材料够不够：每一样都要够，缺一样整件不放。
 *
 * @param {{ quantityOf(itemType: string): number }} ledger
 * @param {readonly { itemType: string, quantity: number }[]} cost
 */
export function canAffordCost(ledger, cost) {
  return cost.every((entry) => ledger.quantityOf(entry.itemType) >= entry.quantity);
}

/**
 * 件该站多高（水上件是**船体本地**高度，静态件是世界高度）。
 *
 * - 水上地基顶面贴齐甲板面；水上墙与物件落在甲板面上；
 * - 静态地基落在那格的支撑面上：陆地格是最高角点（斜坡格才不会有一半陷进坡里），
 *   河床格是水面（码头板浮在水面上）；
 * - 静态墙落在撑着它的地基顶面上，两侧都有地基就取高的那块；没有地基时落在
 *   两侧地形较高的那一格上；
 * - 静态物件落在地基顶面上，没有地基就落在那格地面上。
 *
 * 返回 undefined 表示这里根本没有可站的面。
 *
 * @param {import('./buildGrid.mjs').BuildPlacement} placement
 * @param {{ kind: string, thickness: number }} piece
 * @param {{
 *   groundTopAt(cellX: number, cellZ: number): number | undefined,
 *   foundationTopAt(surfaceKey: string, cellX: number, cellZ: number): number | undefined,
 * }} support
 */
export function resolveBuildElevation(placement, piece, support) {
  if (placement.surface === 'floating') {
    const grid = placement.founding ? placement.hullGrid : placement.grid;
    if (!grid) return undefined;
    return piece.kind === 'foundation' ? grid.deckHeight - piece.thickness : grid.deckHeight;
  }
  const { cellX, cellZ, surfaceKey } = placement;
  if (piece.kind === 'foundation') return support.groundTopAt(cellX, cellZ);
  if (piece.kind === 'fixture') {
    return support.foundationTopAt(surfaceKey, cellX, cellZ) ?? support.groundTopAt(cellX, cellZ);
  }
  let top;
  let ground;
  for (const [x, z] of edgeCells(cellX, cellZ, placement.edge)) {
    const foundationTop = support.foundationTopAt(surfaceKey, x, z);
    if (foundationTop !== undefined && (top === undefined || foundationTop > top)) top = foundationTop;
    const groundTop = support.groundTopAt(x, z);
    if (groundTop !== undefined && (ground === undefined || groundTop > ground)) ground = groundTop;
  }
  return top ?? ground;
}
