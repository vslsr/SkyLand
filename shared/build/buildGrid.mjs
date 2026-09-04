/**
 * 建造网格：把「鼠标指到的一个点」变成「网格里的一格或一条边」。
 *
 * 设计稿（doc/desinger-buildsys.md）把建筑分成两类：
 *
 * - **静态建筑**：不会动。网格是世界对齐的格，格宽等于地形格（2 米），原点在
 *   世界原点。地基占一格，墙占一条格边，物件占格中心的一个槽位。
 * - **水上建筑**：有浮力、会漂。网格挂在一艘船（船体根节点 Actor）的本地空间里，
 *   随船走。**最初的一块水上地基**放在开阔水面上就立起一艘新船：它就是那艘船的
 *   第 (0, 0) 格；后来的地基前后左右吸附在已有甲板旁边，墙吸附在甲板的格边上。
 *   水上地基的大小和地皮的一格一样（2 米），所以两套网格的格宽相同。
 *
 * 这个文件只有纯函数，客户端预览和服务端校验跑的是同一份：幽灵吸附到哪一格，
 * 服务端就往哪一格放，两端不会各算各的。
 *
 * 边的表示只用两种：`north` 是格子 +Z 那一侧，`east` 是 +X 那一侧。格子 -Z 侧的边
 * 就是南邻格的 `north`，-X 侧的边就是西邻格的 `east`。一条边只有一个名字，
 * 两个人从两侧各放一面墙不会放出两面重叠的墙。
 */

import { TERRAIN_CELL_SIZE } from '../world/terrainConfig.mjs';
import { WORLD_PLAY_AREA_HALF_SIZE } from '../world/worldConfig.mjs';

/** 件的种类：地基占一格，墙占一条边，物件占格中心的一个槽位。 */
export const BUILD_PIECE_KINDS = Object.freeze(['foundation', 'wall', 'fixture']);
/** 一个放置位所在的表面：水上（船体网格）或静态（世界网格）。 */
export const BUILD_SURFACES = Object.freeze(['floating', 'static']);
/** 件可以声明的表面：物件两边都能放（`any`），地基与墙必须二选一。 */
export const BUILD_PIECE_SURFACES = Object.freeze(['floating', 'static', 'any']);
export const BUILD_EDGES = Object.freeze(['north', 'east']);

/** 建造格宽就是地形格：地基正好盖住一格地形，边缘不会骑在台阶上；水上地基同宽。 */
export const BUILD_CELL_SIZE = TERRAIN_CELL_SIZE;
export const STATIC_SURFACE_KEY = 'static';

/** 上行的世界格坐标必须落在生成世界里；再远的世界本来就不存在。 */
export const MAX_BUILD_CELL = Math.ceil(WORLD_PLAY_AREA_HALF_SIZE / BUILD_CELL_SIZE);

/**
 * @typedef {object} BuildGrid
 * @property {number} cellSize
 * @property {number} originX 第 0 列的本地 X 起点
 * @property {number} originZ 第 0 行的本地 Z 起点
 */

/**
 * @typedef {BuildGrid & {
 *   columns: number,
 *   rows: number,
 *   deckHeight: number,
 *   extentCells: number,
 *   maxPieces: number,
 * }} HullBuildGrid
 */

/** 静态建筑用的世界网格。 */
/** @type {BuildGrid} */
export const WORLD_BUILD_GRID = Object.freeze({
  cellSize: BUILD_CELL_SIZE,
  originX: 0,
  originZ: 0,
});

function finiteOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * 船体原型的 `buildGrid` 定义 → 以船体根节点为原点的网格。
 *
 * `columns × rows` 是船体自带的甲板（预制的木筏有，用地基立起来的船没有，
 * 写 0）。自带甲板时原点落在甲板左后角，第 (0, 0) 格是甲板的一角；没有自带甲板
 * 时原点落在第 (0, 0) 格的中心——最初那块地基就放在根节点正下方。
 *
 * @returns {HullBuildGrid}
 */
export function createHullBuildGrid(definition) {
  const cellSize = Math.max(0.25, finiteOr(definition?.cellSize, BUILD_CELL_SIZE));
  const columns = Math.max(0, Math.floor(finiteOr(definition?.columns, 0)));
  const rows = Math.max(0, Math.floor(finiteOr(definition?.rows, 0)));
  return {
    cellSize,
    columns,
    rows,
    originX: columns > 0 ? -(columns * cellSize) / 2 : -cellSize / 2,
    originZ: rows > 0 ? -(rows * cellSize) / 2 : -cellSize / 2,
    deckHeight: finiteOr(definition?.deckHeight, 0.16),
    extentCells: Math.max(0, Math.floor(finiteOr(definition?.extentCells, 6))),
    maxPieces: Math.max(0, Math.floor(finiteOr(definition?.maxPieces, 48))),
  };
}

/** 本地点落在哪一格。 */
export function cellOf(grid, localX, localZ) {
  return {
    cellX: Math.floor((localX - grid.originX) / grid.cellSize),
    cellZ: Math.floor((localZ - grid.originZ) / grid.cellSize),
  };
}

/** 一格的中心（本地坐标）。 */
export function cellCenter(grid, cellX, cellZ) {
  return {
    x: grid.originX + (cellX + 0.5) * grid.cellSize,
    z: grid.originZ + (cellZ + 0.5) * grid.cellSize,
  };
}

/**
 * 离本地点最近的那条格边，已经规范成 `north` / `east` 两种之一。
 *
 * 鼠标在格子里偏向哪一侧，墙就吸到哪一侧：这就是墙的「吸附」。
 */
export function nearestEdge(grid, localX, localZ) {
  const { cellX, cellZ } = cellOf(grid, localX, localZ);
  const fractionX = (localX - grid.originX) / grid.cellSize - cellX;
  const fractionZ = (localZ - grid.originZ) / grid.cellSize - cellZ;
  const candidates = [
    { distance: 1 - fractionZ, cellX, cellZ, edge: 'north' },
    { distance: fractionZ, cellX, cellZ: cellZ - 1, edge: 'north' },
    { distance: 1 - fractionX, cellX, cellZ, edge: 'east' },
    { distance: fractionX, cellX: cellX - 1, cellZ, edge: 'east' },
  ];
  let best = candidates[0];
  for (const candidate of candidates) {
    if (candidate.distance < best.distance) best = candidate;
  }
  return { cellX: best.cellX, cellZ: best.cellZ, edge: best.edge };
}

/** 一条边两侧的两格：`north` 边分开 (x, z) 与 (x, z+1)，`east` 边分开 (x, z) 与 (x+1, z)。 */
export function edgeCells(cellX, cellZ, edge) {
  return edge === 'east'
    ? [[cellX, cellZ], [cellX + 1, cellZ]]
    : [[cellX, cellZ], [cellX, cellZ + 1]];
}

/** 围着一格的四条边，按规范名字给出（南边是南邻格的 north，西边是西邻格的 east）。 */
export function cellEdges(cellX, cellZ) {
  return [
    { cellX, cellZ, edge: 'north' },
    { cellX, cellZ: cellZ - 1, edge: 'north' },
    { cellX, cellZ, edge: 'east' },
    { cellX: cellX - 1, cellZ, edge: 'east' },
  ];
}

/** 四邻格。 */
export function cellNeighbors(cellX, cellZ) {
  return [
    [cellX + 1, cellZ],
    [cellX - 1, cellZ],
    [cellX, cellZ + 1],
    [cellX, cellZ - 1],
  ];
}

/**
 * 一条边上墙的本地位姿：墙沿本地 X 展开，所以 `north` 边（平行 X）yaw 为 0，
 * `east` 边（平行 Z）转 90°。位置在边的中点。
 */
export function edgePose(grid, cellX, cellZ, edge) {
  const center = cellCenter(grid, cellX, cellZ);
  const half = grid.cellSize / 2;
  return edge === 'east'
    ? { x: center.x + half, z: center.z, yaw: Math.PI / 2 }
    : { x: center.x, z: center.z + half, yaw: 0 };
}

/** 船体自带的甲板格（预制木筏才有）。 */
export function isHullCell(grid, cellX, cellZ) {
  return cellX >= 0 && cellX < grid.columns && cellZ >= 0 && cellZ < grid.rows;
}

/** 船最多能往外扩到哪：自带甲板（没有就是第 (0, 0) 格）四周 extentCells 格以内。 */
export function isWithinHullExtent(grid, cellX, cellZ) {
  const extent = grid.extentCells;
  const maximumX = Math.max(grid.columns, 1) - 1;
  const maximumZ = Math.max(grid.rows, 1) - 1;
  return cellX >= -extent && cellX <= maximumX + extent
    && cellZ >= -extent && cellZ <= maximumZ + extent;
}

/** 船体本地 → 世界（只管水平面；高度由浮力另算）。 */
export function hullLocalToWorld(hull, localX, localZ) {
  const cos = Math.cos(hull.yaw);
  const sin = Math.sin(hull.yaw);
  return {
    x: hull.x + cos * localX + sin * localZ,
    z: hull.z - sin * localX + cos * localZ,
  };
}

/** 世界 → 船体本地。 */
export function worldToHullLocal(hull, x, z) {
  const cos = Math.cos(hull.yaw);
  const sin = Math.sin(hull.yaw);
  const dx = x - hull.x;
  const dz = z - hull.z;
  return {
    x: cos * dx - sin * dz,
    z: sin * dx + cos * dz,
  };
}

/**
 * 一个世界格是否整格落在活动范围内。两端都用它判「超出范围」，半格悬在边界外
 * 的地基也不放行——那半格外面没有地面碰撞，角色会从板子上掉下去。
 *
 * @param {{ minimumX: number, maximumX: number, minimumZ: number, maximumZ: number } | undefined} bounds
 */
export function cellWithinBounds(cellX, cellZ, bounds, cellSize = BUILD_CELL_SIZE) {
  if (Math.abs(cellX) > MAX_BUILD_CELL || Math.abs(cellZ) > MAX_BUILD_CELL) return false;
  if (!bounds) return true;
  const minimumX = cellX * cellSize;
  const minimumZ = cellZ * cellSize;
  return minimumX >= bounds.minimumX
    && minimumX + cellSize <= bounds.maximumX
    && minimumZ >= bounds.minimumZ
    && minimumZ + cellSize <= bounds.maximumZ;
}

/**
 * 一件东西在格子里占的槽位：地基占整格、墙占一条边、物件占格中心里以它的
 * `slot` 命名的那个槽——棚子和篝火各占一个槽，可以同在一格；两个篝火不行。
 * 这就是设计稿里「物件之间的互斥属性」。
 */
export function siteSlotOf(piece, edge) {
  if (piece.kind === 'wall') return edge;
  if (piece.kind === 'fixture') return `fixture:${piece.slot ?? 'default'}`;
  return 'cell';
}

/** 占位表的键。一格、一条边、一格里的一个物件槽各只能有一件东西。 */
export function buildSiteKey(surfaceKey, cellX, cellZ, slot) {
  return `${surfaceKey}|${cellX}|${cellZ}|${slot ?? 'cell'}`;
}

/**
 * @typedef {object} BuildPlacement
 * @property {'floating'|'static'} surface
 * @property {string | undefined} surfaceKey 静态是 `static`，船上是船体根节点 id，立新船时还没有
 * @property {string} [hullActorId]
 * @property {number} [hullY] 船体根节点的世界高度；水上件的世界 Y = 它 + 本地高度
 * @property {boolean} founding 水上地基没有船可吸附：在这一格立一艘新船
 * @property {HullBuildGrid} [hullGrid] 立新船时那艘船会用的网格
 * @property {HullBuildGrid | BuildGrid} grid
 * @property {number} cellX
 * @property {number} cellZ
 * @property {'north'|'east'} [edge] 只有墙才有
 * @property {number} localX 网格本地位姿（静态即世界）
 * @property {number} localZ
 * @property {number} localYaw
 * @property {number} x 世界位姿
 * @property {number} z
 * @property {number} yaw
 */

function placeOnGrid(surface, surfaceKey, grid, piece, localX, localZ, hull) {
  const site = piece.kind === 'wall' ? nearestEdge(grid, localX, localZ) : cellOf(grid, localX, localZ);
  return fromSite(surface, surfaceKey, grid, piece, site.cellX, site.cellZ, site.edge, hull);
}

function fromSite(surface, surfaceKey, grid, piece, cellX, cellZ, edge, hull) {
  const pose = piece.kind === 'wall'
    ? edgePose(grid, cellX, cellZ, edge)
    : { ...cellCenter(grid, cellX, cellZ), yaw: 0 };
  const world = hull ? hullLocalToWorld(hull, pose.x, pose.z) : { x: pose.x, z: pose.z };
  return {
    surface,
    surfaceKey,
    ...(hull ? { hullActorId: hull.actorId, hullY: finiteOr(hull.y) } : {}),
    founding: false,
    grid,
    cellX,
    cellZ,
    ...(edge ? { edge } : {}),
    localX: pose.x,
    localZ: pose.z,
    localYaw: pose.yaw,
    x: world.x,
    z: world.z,
    yaw: hull ? hull.yaw + pose.yaw : pose.yaw,
  };
}

/**
 * 离这个点最近的、**可以接上去**的那艘船。
 *
 * `accepts` 说明「接上去」是什么意思，两种件不一样：
 *
 * - **地基**要求这一格紧挨着已有甲板。这就是设计稿里的「前后左右与其他水上地基
 *   对齐吸附」：挨着就接到那座船坞上，不挨着就不算这艘船的事——调用方会在那里
 *   立一艘新的。范围（`extentCells`）不参与吸附，它只是那艘船还能长多大的上限。
 * - **墙与物件**只按范围找船：它们本来就该落在船上，落在没有甲板的格子上时
 *   幽灵停在船上变红说「下面没有地基撑着」，比跳回世界网格好读。
 */
function nearestHullAt(point, hulls, accepts) {
  let nearest;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const hull of hulls) {
    const local = worldToHullLocal(hull, point.x, point.z);
    const site = cellOf(hull.grid, local.x, local.z);
    const distance = Math.hypot(point.x - hull.x, point.z - hull.z);
    if (distance >= nearestDistance) continue;
    if (!accepts(hull, site.cellX, site.cellZ)) continue;
    nearest = { hull, local };
    nearestDistance = distance;
  }
  return nearest;
}

/** 这一格上有没有甲板：船体自带的算，已经铺上去的地基也算。 */
function deckAt(hull, cellX, cellZ, hasDeck) {
  return isHullCell(hull.grid, cellX, cellZ) || hasDeck(hull.actorId, cellX, cellZ);
}

/**
 * 把指到的点吸附成一个放置位。
 *
 * 水上件先找船：点落在某艘船的扩建范围里就吸到那艘船的网格上（几艘重叠时取最近的
 * 一艘）。找不到船时，水上地基就在这个世界格上立一艘新船；水上墙和只能上船的
 * 物件没船可靠，返回的放置位会在校验里被拒。静态件与没找到船的物件落到世界网格。
 *
 * @param {{ x: number, z: number }} point
 * @param {{ kind: string, surface: string, slot?: string, hull?: string }} piece
 * @param {readonly { actorId: string, x: number, y?: number, z: number, yaw: number, grid: HullBuildGrid }[]} hulls
 * @param {{
 *   hullGrid?: HullBuildGrid,
 *   hasDeck?: (surfaceKey: string, cellX: number, cellZ: number) => boolean,
 * }} [options] `hullGrid` 是这种地基立起来的船会用的网格；`hasDeck` 说某格上有没有铺过地基
 * @returns {BuildPlacement}
 */
export function resolveBuildPlacement(point, piece, hulls = [], options = {}) {
  const { hullGrid, hasDeck = () => false } = options;
  if (piece.surface === 'floating' || piece.surface === 'any') {
    const accepts = piece.kind === 'foundation'
      // 挨着已有甲板才算接到这艘船上；不挨着的地方是一座新的船坞。
      // 这一格自己就是甲板时也算这艘船的事——那样指着一块板会说「这里已经有东西了」，
      // 而不是当成在别人的板上另起一座。
      ? (hull, cellX, cellZ) => deckAt(hull, cellX, cellZ, hasDeck)
        || cellNeighbors(cellX, cellZ).some(([x, z]) => deckAt(hull, x, z, hasDeck))
      : (hull, cellX, cellZ) => isWithinHullExtent(hull.grid, cellX, cellZ);
    const hit = nearestHullAt(point, hulls, accepts);
    if (hit) {
      return placeOnGrid('floating', hit.hull.actorId, hit.hull.grid, piece, hit.local.x, hit.local.z, hit.hull);
    }
  }
  if (piece.surface === 'floating') {
    return {
      ...placeOnGrid('floating', undefined, WORLD_BUILD_GRID, piece, point.x, point.z),
      founding: true,
      ...(hullGrid ? { hullGrid } : {}),
    };
  }
  return placeOnGrid('static', STATIC_SURFACE_KEY, WORLD_BUILD_GRID, piece, point.x, point.z);
}

/**
 * 从上行报文重建放置位：客户端发的是格坐标而不是世界坐标，服务端按权威船体
 * 位姿重新算出世界位姿。格坐标不合法就返回 undefined。
 *
 * @param {{ surface: string, hullActorId?: string, cellX: number, cellZ: number, edge?: string }} request
 * @param {{ kind: string, surface: string, slot?: string, hull?: string }} piece
 * @param {{ actorId: string, x: number, y?: number, z: number, yaw: number, grid: HullBuildGrid } | undefined} hull
 * @param {HullBuildGrid} [hullGrid]
 * @returns {BuildPlacement | undefined}
 */
export function restoreBuildPlacement(request, piece, hull, hullGrid = undefined) {
  const cellX = Number(request?.cellX);
  const cellZ = Number(request?.cellZ);
  if (!Number.isInteger(cellX) || !Number.isInteger(cellZ)) return undefined;
  const edge = request?.edge;
  if (piece.kind === 'wall' ? !BUILD_EDGES.includes(edge) : edge !== undefined) return undefined;
  const surface = request?.surface;
  if (surface === 'floating') {
    if (hull) {
      if (Math.abs(cellX) > 4096 || Math.abs(cellZ) > 4096) return undefined;
      return fromSite('floating', hull.actorId, hull.grid, piece, cellX, cellZ, edge, hull);
    }
    // 没指定船：只有水上地基能在这一格立一艘新船。
    if (piece.kind !== 'foundation' || piece.surface !== 'floating') return undefined;
    if (Math.abs(cellX) > MAX_BUILD_CELL || Math.abs(cellZ) > MAX_BUILD_CELL) return undefined;
    return {
      ...fromSite('floating', undefined, WORLD_BUILD_GRID, piece, cellX, cellZ, edge),
      founding: true,
      ...(hullGrid ? { hullGrid } : {}),
    };
  }
  if (surface !== 'static') return undefined;
  if (Math.abs(cellX) > MAX_BUILD_CELL || Math.abs(cellZ) > MAX_BUILD_CELL) return undefined;
  return fromSite('static', STATIC_SURFACE_KEY, WORLD_BUILD_GRID, piece, cellX, cellZ, edge);
}
