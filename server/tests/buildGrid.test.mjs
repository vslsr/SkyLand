import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUILD_CELL_SIZE,
  BUILD_REJECTIONS,
  BuildSiteIndex,
  STATIC_SURFACE_KEY,
  cellEdges,
  cellWithinBounds,
  createHullBuildGrid,
  edgeCells,
  findDependentPieces,
  footprintBlocked,
  hullLocalToWorld,
  isHullCell,
  isWithinHullExtent,
  nearestEdge,
  pieceFootprint,
  resolveBuildElevation,
  resolveBuildPlacement,
  restoreBuildPlacement,
  siteSlotOf,
  validateBuildPlacement,
  worldToHullLocal,
} from '../../shared/build/index.mjs';

const HULL_GRID = createHullBuildGrid({
  cellSize: 2, columns: 0, rows: 0, deckHeight: 0.16, extentCells: 3, maxPieces: 8,
});
const RAFT_GRID = createHullBuildGrid({
  cellSize: 1.6, columns: 2, rows: 3, deckHeight: 0.47, extentCells: 2, maxPieces: 8,
});

const FLOAT_FOUNDATION = { kind: 'foundation', surface: 'floating', reach: 6, hull: 'float-hull' };
const FLOAT_WALL = { kind: 'wall', surface: 'floating', reach: 6 };
const GROUND_FOUNDATION = { kind: 'foundation', surface: 'static', reach: 6 };
const STATIC_WALL = { kind: 'wall', surface: 'static', reach: 6 };
const CAMPFIRE = { kind: 'fixture', surface: 'any', reach: 6, slot: 'hearth' };

/** 吸附：地基要知道哪一格已经铺过板，才判得出「挨没挨着这座船坞」。 */
function snap(point, piece, hulls = [], sites = new BuildSiteIndex()) {
  return resolveBuildPlacement(point, piece, hulls, {
    hullGrid: HULL_GRID,
    hasDeck: (surfaceKey, cellX, cellZ) => sites.hasFoundation(surfaceKey, cellX, cellZ),
  });
}

/** 规则上下文的默认值：什么都不挡、什么都买得起，逐条用例再改自己关心的那一项。 */
function context(sites, overrides = {}) {
  return {
    distance: 1,
    hasLand: true,
    cellStatus: () => 'land',
    isOccupied: (...args) => sites.isOccupied(...args),
    hasFoundation: (...args) => sites.hasFoundation(...args),
    isBlocked: () => false,
    canAfford: true,
    withinBudget: true,
    ...overrides,
  };
}

test('墙的边只有 north / east 两个名字：从两侧指同一条边得到同一个键', () => {
  const grid = { cellSize: 2, originX: 0, originZ: 0 };
  // 格 (0,0) 的南边就是格 (0,-1) 的 north。
  assert.deepEqual(nearestEdge(grid, 1, 0.1), { cellX: 0, cellZ: -1, edge: 'north' });
  assert.deepEqual(nearestEdge(grid, 1, -0.1), { cellX: 0, cellZ: -1, edge: 'north' });
  // 格 (0,0) 的西边就是格 (-1,0) 的 east。
  assert.deepEqual(nearestEdge(grid, 0.1, 1), { cellX: -1, cellZ: 0, edge: 'east' });
  assert.deepEqual(nearestEdge(grid, -0.1, 1), { cellX: -1, cellZ: 0, edge: 'east' });
  // 一格四条边与一条边两侧的格互为反查。
  for (const edge of cellEdges(3, -2)) {
    assert.ok(edgeCells(edge.cellX, edge.cellZ, edge.edge).some(([x, z]) => x === 3 && z === -2));
  }
});

test('船体本地与世界坐标互逆，转过角度的船也一样', () => {
  const hull = { actorId: 'h', x: 4, z: -3, yaw: 1.1, grid: HULL_GRID };
  const world = hullLocalToWorld(hull, 2, -1);
  const local = worldToHullLocal(hull, world.x, world.z);
  assert.ok(Math.abs(local.x - 2) < 1e-9 && Math.abs(local.z + 1) < 1e-9);
});

test('用地基立起来的船：第 (0,0) 格在根节点正下方，没有自带甲板', () => {
  assert.equal(HULL_GRID.originX, -1);
  assert.equal(isHullCell(HULL_GRID, 0, 0), false);
  assert.equal(isWithinHullExtent(HULL_GRID, 3, -3), true);
  assert.equal(isWithinHullExtent(HULL_GRID, 4, 0), false);
  // 预制木筏自带 2×3 格甲板，扩建范围从甲板四周算。
  assert.equal(isHullCell(RAFT_GRID, 1, 2), true);
  assert.equal(isWithinHullExtent(RAFT_GRID, 3, 4), true);
  assert.equal(isWithinHullExtent(RAFT_GRID, 4, 0), false);
});

test('水上地基：挨着甲板就接到那座船坞上，不挨着就是新的一座', () => {
  const founding = snap({ x: 5.2, z: -3.9 }, FLOAT_FOUNDATION);
  assert.equal(founding.founding, true);
  assert.equal(founding.surface, 'floating');
  assert.equal(founding.surfaceKey, undefined);
  assert.deepEqual([founding.cellX, founding.cellZ], [2, -2]);
  assert.deepEqual([founding.x, founding.z], [5, -3]);
  assert.equal(founding.hullGrid, HULL_GRID);

  // 这艘船的第 (0,0) 格上铺着一块板；挨着它的那一格接到这艘船上。
  const hull = { actorId: 'hull-1', x: 5, y: 0, z: -3, yaw: 0, grid: HULL_GRID };
  const sites = new BuildSiteIndex();
  sites.add({ actorId: 'root', surfaceKey: 'hull-1', kind: 'foundation', cellX: 0, cellZ: 0 });
  const next = snap({ x: 7.1, z: -3.2 }, FLOAT_FOUNDATION, [hull], sites);
  assert.equal(next.founding, false);
  assert.equal(next.hullActorId, 'hull-1');
  assert.deepEqual([next.cellX, next.cellZ], [1, 0]);
  assert.deepEqual([next.x, next.z], [7, -3]);

  // 同一个点，船上那格还空着时不算挨着——那就是另一座船坞的开头。
  assert.equal(snap({ x: 7.1, z: -3.2 }, FLOAT_FOUNDATION, [hull]).founding, true);
  // 斜对角不算挨着。
  assert.equal(snap({ x: 7.1, z: -1.2 }, FLOAT_FOUNDATION, [hull], sites).founding, true);
  // 隔着一格的水面也不算：那里是新的一座。
  assert.equal(snap({ x: 30, z: -3 }, FLOAT_FOUNDATION, [hull], sites).founding, true);
});

test('物件两边都能放：有船吸船，没船落地；静态件永远落地', () => {
  const hull = { actorId: 'hull-1', x: 0, y: 0, z: 0, yaw: 0, grid: HULL_GRID };
  // 墙和物件按范围找船：落在没有甲板的格子上时幽灵停在船上变红，不跳回世界网格。
  assert.equal(snap({ x: 0.3, z: 0.2 }, CAMPFIRE, [hull]).surfaceKey, 'hull-1');
  assert.equal(snap({ x: 40, z: 40 }, CAMPFIRE, [hull]).surfaceKey, STATIC_SURFACE_KEY);
  assert.equal(snap({ x: 0.3, z: 0.2 }, GROUND_FOUNDATION, [hull]).surfaceKey, STATIC_SURFACE_KEY);
});

test('上行的格坐标能还原成同一个放置位；脏数据还原不出来', () => {
  const hull = { actorId: 'hull-1', x: 2, y: 0, z: 2, yaw: 0.7, grid: HULL_GRID };
  const wall = snap({ x: 2.4, z: 3.3 }, FLOAT_WALL, [hull]);
  const restored = restoreBuildPlacement(
    { surface: 'floating', hullActorId: 'hull-1', cellX: wall.cellX, cellZ: wall.cellZ, edge: wall.edge },
    FLOAT_WALL,
    hull,
  );
  assert.ok(Math.abs(restored.x - wall.x) < 1e-9 && Math.abs(restored.yaw - wall.yaw) < 1e-9);

  const founding = restoreBuildPlacement({ surface: 'floating', cellX: 2, cellZ: -2 }, FLOAT_FOUNDATION, undefined, HULL_GRID);
  assert.equal(founding.founding, true);
  assert.deepEqual([founding.x, founding.z], [5, -3]);

  assert.equal(restoreBuildPlacement({ surface: 'floating', cellX: 1, cellZ: 1 }, FLOAT_WALL, undefined), undefined, '墙不能立船');
  assert.equal(restoreBuildPlacement({ surface: 'static', cellX: 1.5, cellZ: 0 }, GROUND_FOUNDATION), undefined);
  assert.equal(restoreBuildPlacement({ surface: 'static', cellX: 1, cellZ: 0, edge: 'west' }, STATIC_WALL), undefined);
  assert.equal(restoreBuildPlacement({ surface: 'static', cellX: 1, cellZ: 0, edge: 'north' }, GROUND_FOUNDATION), undefined);
  assert.equal(restoreBuildPlacement({ surface: 'moon', cellX: 1, cellZ: 0 }, GROUND_FOUNDATION), undefined);
  assert.equal(restoreBuildPlacement({ surface: 'static', cellX: 1e9, cellZ: 0 }, GROUND_FOUNDATION), undefined);
});

test('整格落在活动范围内才算在范围内', () => {
  const bounds = { minimumX: -4, maximumX: 4, minimumZ: -4, maximumZ: 4 };
  assert.equal(cellWithinBounds(1, 1, bounds), true);
  assert.equal(cellWithinBounds(2, 0, bounds), false, '格 [4,6) 悬在边界外');
  assert.equal(cellWithinBounds(-2, -2, bounds), true);
  assert.equal(cellWithinBounds(1, 1, undefined), true);
});

test('水上地基：立船要在水里，扩建要挨着甲板、不出范围、不盖自带甲板', () => {
  const sites = new BuildSiteIndex();
  const founding = snap({ x: 1, z: 1 }, FLOAT_FOUNDATION);
  assert.equal(validateBuildPlacement(founding, FLOAT_FOUNDATION, context(sites, { cellStatus: () => 'land' })).reason, BUILD_REJECTIONS.NEEDS_WATER);
  assert.equal(validateBuildPlacement(founding, FLOAT_FOUNDATION, context(sites, { cellStatus: () => 'bounds' })).reason, BUILD_REJECTIONS.BOUNDS);
  assert.equal(validateBuildPlacement(founding, FLOAT_FOUNDATION, context(sites, { cellStatus: () => 'water' })).ok, true);
  // 没有 hull 定义的水上地基立不了船。
  const noHull = { ...FLOAT_FOUNDATION, hull: undefined };
  assert.equal(validateBuildPlacement(
    resolveBuildPlacement({ x: 1, z: 1 }, noHull, [], {}),
    noHull,
    context(sites, { cellStatus: () => 'water' }),
  ).reason, BUILD_REJECTIONS.SUPPORT);

  const hull = { actorId: 'hull-1', x: 0, y: 0, z: 0, yaw: 0, grid: HULL_GRID };
  sites.add({ actorId: 'root', surfaceKey: 'hull-1', kind: 'foundation', cellX: 0, cellZ: 0 });
  const adjacent = snap({ x: 2.2, z: 0 }, FLOAT_FOUNDATION, [hull], sites);
  assert.equal(validateBuildPlacement(adjacent, FLOAT_FOUNDATION, context(sites)).ok, true);
  // 斜对角吸不到这艘船，它是另一座船坞的开头——那里得是水。
  const diagonal = snap({ x: 2.2, z: 2.2 }, FLOAT_FOUNDATION, [hull], sites);
  assert.equal(diagonal.founding, true);
  assert.equal(validateBuildPlacement(diagonal, FLOAT_FOUNDATION, context(sites, { cellStatus: () => 'water' })).ok, true);
  const same = snap({ x: 0.2, z: 0 }, FLOAT_FOUNDATION, [hull], sites);
  assert.equal(validateBuildPlacement(same, FLOAT_FOUNDATION, context(sites)).reason, BUILD_REJECTIONS.OCCUPIED);

  // 预制木筏：自带甲板算甲板，挨着它就接上去，甲板本身不能再铺一层。
  const raft = { actorId: 'raft', x: 0, y: 0, z: 0, yaw: 0, grid: RAFT_GRID };
  const onDeck = snap({ x: 0.2, z: 0.2 }, FLOAT_FOUNDATION, [raft]);
  assert.equal(onDeck.hullActorId, 'raft');
  assert.equal(validateBuildPlacement(onDeck, FLOAT_FOUNDATION, context(sites)).reason, BUILD_REJECTIONS.OCCUPIED);
  const beside = snap({ x: 2.2, z: 0.2 }, FLOAT_FOUNDATION, [raft]);
  assert.equal(beside.hullActorId, 'raft');
  assert.equal(validateBuildPlacement(beside, FLOAT_FOUNDATION, context(sites)).ok, true);
  // 离甲板远的点根本不会吸到船上；只有上行报文硬指一格时才会走到 EXTENT。
  assert.equal(snap({ x: 5.5, z: 0.2 }, FLOAT_FOUNDATION, [raft]).founding, true);
  const tooFar = restoreBuildPlacement({ surface: 'floating', hullActorId: 'raft', cellX: 4, cellZ: 0 }, FLOAT_FOUNDATION, raft);
  assert.equal(validateBuildPlacement(tooFar, FLOAT_FOUNDATION, context(sites)).reason, BUILD_REJECTIONS.EXTENT);
});

test('墙要有地基撑着；静态墙也能直接立在地形格边上', () => {
  const sites = new BuildSiteIndex();
  const hull = { actorId: 'hull-1', x: 0, y: 0, z: 0, yaw: 0, grid: HULL_GRID };
  sites.add({ actorId: 'root', surfaceKey: 'hull-1', kind: 'foundation', cellX: 0, cellZ: 0 });
  const onEdge = snap({ x: 0, z: 0.9 }, FLOAT_WALL, [hull]);
  assert.deepEqual([onEdge.cellX, onEdge.cellZ, onEdge.edge], [0, 0, 'north']);
  assert.equal(validateBuildPlacement(onEdge, FLOAT_WALL, context(sites)).ok, true);
  const floating = snap({ x: 4, z: 2.9 }, FLOAT_WALL, [hull]);
  assert.equal(validateBuildPlacement(floating, FLOAT_WALL, context(sites)).reason, BUILD_REJECTIONS.SUPPORT);
  // 同一条边不能放两面墙。
  sites.add({ actorId: 'w1', surfaceKey: 'hull-1', kind: 'wall', cellX: 0, cellZ: 0, edge: 'north' });
  assert.equal(validateBuildPlacement(onEdge, FLOAT_WALL, context(sites)).reason, BUILD_REJECTIONS.OCCUPIED);

  const onTerrain = snap({ x: 10, z: 9.9 }, STATIC_WALL);
  assert.equal(validateBuildPlacement(onTerrain, STATIC_WALL, context(sites)).ok, true);
  assert.equal(validateBuildPlacement(onTerrain, STATIC_WALL, context(sites, { cellStatus: () => 'bounds' })).reason, BUILD_REJECTIONS.BOUNDS);
  assert.equal(validateBuildPlacement(onTerrain, STATIC_WALL, context(sites, { hasLand: false })).reason, BUILD_REJECTIONS.NO_LAND);
});

test('静态地基能放在陆地和河床上；物件落地只能落在陆地格或地基上', () => {
  const sites = new BuildSiteIndex();
  const pier = snap({ x: 10, z: 10 }, GROUND_FOUNDATION);
  assert.equal(validateBuildPlacement(pier, GROUND_FOUNDATION, context(sites, { cellStatus: () => 'water' })).ok, true);
  assert.equal(validateBuildPlacement(pier, GROUND_FOUNDATION, context(sites, { cellStatus: () => 'bounds' })).reason, BUILD_REJECTIONS.BOUNDS);

  const fire = snap({ x: 10, z: 10 }, CAMPFIRE);
  assert.equal(validateBuildPlacement(fire, CAMPFIRE, context(sites)).ok, true);
  assert.equal(validateBuildPlacement(fire, CAMPFIRE, context(sites, { cellStatus: () => 'water' })).reason, BUILD_REJECTIONS.SUPPORT);
  sites.add({ actorId: 'f1', surfaceKey: STATIC_SURFACE_KEY, kind: 'foundation', cellX: 5, cellZ: 5 });
  assert.equal(validateBuildPlacement(fire, CAMPFIRE, context(sites, { cellStatus: () => 'water' })).ok, true, '河床上的码头板上可以放');
  // 同槽互斥，异槽共存。
  sites.add({ actorId: 'c1', surfaceKey: STATIC_SURFACE_KEY, kind: 'fixture', slot: 'hearth', cellX: 5, cellZ: 5 });
  assert.equal(validateBuildPlacement(fire, CAMPFIRE, context(sites)).reason, BUILD_REJECTIONS.OCCUPIED);
  const shelter = { ...CAMPFIRE, slot: 'shelter' };
  assert.equal(validateBuildPlacement(fire, shelter, context(sites)).ok, true);
});

test('几何都过了才轮到实体、预算与材料，顺序决定幽灵先说什么', () => {
  const sites = new BuildSiteIndex();
  const pier = snap({ x: 10, z: 10 }, GROUND_FOUNDATION);
  assert.equal(validateBuildPlacement(pier, GROUND_FOUNDATION, context(sites, { distance: 7 })).reason, BUILD_REJECTIONS.REACH);
  assert.equal(validateBuildPlacement(pier, GROUND_FOUNDATION, context(sites, { isBlocked: () => true, canAfford: false })).reason, BUILD_REJECTIONS.BLOCKED);
  assert.equal(validateBuildPlacement(pier, GROUND_FOUNDATION, context(sites, { withinBudget: false, canAfford: false })).reason, BUILD_REJECTIONS.BUDGET);
  assert.equal(validateBuildPlacement(pier, GROUND_FOUNDATION, context(sites, { canAfford: false })).reason, BUILD_REJECTIONS.MATERIALS);
  assert.equal(validateBuildPlacement(pier, FLOAT_WALL, context(sites)).reason, BUILD_REJECTIONS.SURFACE, '表面不对');
});

test('高度：水上件按甲板面算本地高度，静态件按地面与地基顶面算', () => {
  const support = {
    groundTopAt: (x, z) => (x === 5 && z === 5 ? 1.5 : 0.4),
    foundationTopAt: (key, x, z) => (x === 5 && z === 5 ? 1.62 : undefined),
  };
  const founding = snap({ x: 1, z: 1 }, FLOAT_FOUNDATION);
  assert.ok(Math.abs(resolveBuildElevation(founding, { kind: 'foundation', thickness: 0.16 }, support)) < 1e-9);
  const hull = { actorId: 'hull-1', x: 0, y: 0, z: 0, yaw: 0, grid: HULL_GRID };
  const wall = snap({ x: 0, z: 0.9 }, FLOAT_WALL, [hull]);
  assert.equal(resolveBuildElevation(wall, { kind: 'wall', thickness: 0 }, support), 0.16);

  const pier = snap({ x: 11, z: 11 }, GROUND_FOUNDATION);
  assert.equal(resolveBuildElevation(pier, { kind: 'foundation', thickness: 0.12 }, support), 1.5);
  const wallOnPier = snap({ x: 11, z: 11.9 }, STATIC_WALL);
  assert.equal(resolveBuildElevation(wallOnPier, { kind: 'wall', thickness: 0 }, support), 1.62, '取地基顶面');
  const wallOnGround = snap({ x: 21, z: 21.9 }, STATIC_WALL);
  assert.equal(resolveBuildElevation(wallOnGround, { kind: 'wall', thickness: 0 }, support), 0.4, '没有地基就落地');
  const fire = snap({ x: 11, z: 11 }, CAMPFIRE);
  assert.equal(resolveBuildElevation(fire, { kind: 'fixture', thickness: 0 }, support), 1.62);
});

test('占位表：每种槽位各一件，拆地基前要先拆它撑着的墙和上面的物件', () => {
  const sites = new BuildSiteIndex();
  assert.equal(sites.add({ actorId: 'f', surfaceKey: 's', kind: 'foundation', cellX: 0, cellZ: 0, builderPlayerId: 'p' }), true);
  assert.equal(sites.add({ actorId: 'f2', surfaceKey: 's', kind: 'foundation', cellX: 0, cellZ: 0 }), false, '一格一块地基');
  assert.equal(sites.add({ actorId: 'w', surfaceKey: 's', kind: 'wall', cellX: 0, cellZ: 0, edge: 'north', builderPlayerId: 'p' }), true);
  assert.equal(sites.add({ actorId: 'c', surfaceKey: 's', kind: 'fixture', slot: 'hearth', cellX: 0, cellZ: 0 }), true);
  assert.equal(sites.add({ actorId: 'c2', surfaceKey: 's', kind: 'fixture', slot: 'shelter', cellX: 0, cellZ: 0 }), true, '异槽共存');
  assert.equal(sites.size, 4);
  assert.equal(sites.countByBuilder('p'), 2);
  assert.equal(sites.countBySurface('s'), 4);
  assert.equal(siteSlotOf({ kind: 'fixture', slot: 'hearth' }), 'fixture:hearth');
  assert.equal(sites.isOccupied('s', 0, 0, 'fixture:hearth'), true);

  const placementLike = { surface: 'static', surfaceKey: 's', grid: { cellSize: BUILD_CELL_SIZE, originX: 0, originZ: 0 } };
  const dependents = findDependentPieces(sites.getByActor('f'), sites, placementLike).map((record) => record.actorId).sort();
  assert.deepEqual(dependents, ['c', 'c2', 'w']);
  // 墙的另一侧有地基撑着就不算依赖。
  sites.add({ actorId: 'f3', surfaceKey: 's', kind: 'foundation', cellX: 0, cellZ: 1 });
  assert.deepEqual(findDependentPieces(sites.getByActor('f'), sites, placementLike).map((record) => record.actorId).sort(), ['c', 'c2']);
  sites.remove('c');
  sites.remove('c2');
  assert.deepEqual(findDependentPieces(sites.getByActor('f'), sites, placementLike), []);
  assert.equal(sites.remove('f').actorId, 'f');
  assert.equal(sites.countByBuilder('p'), 1);
  assert.equal(sites.getByActor('f'), undefined);
});

test('实体碰撞：玩家站在放置位上就挡住，贴着放的地基和落在地基上的墙不算', () => {
  const slab = pieceFootprint({ x: 1, z: 1, yaw: 0 }, { halfWidth: 1, halfLength: 1, minimumY: 0, maximumY: 0.12 }, 0);
  assert.equal(footprintBlocked(slab, { forEachNear: () => {}, cylinders: [{ x: 1.8, y: 0, z: 1, radius: 0.42, height: 0.84 }] }), true);
  assert.equal(footprintBlocked(slab, { forEachNear: () => {}, cylinders: [{ x: 3.5, y: 0, z: 1, radius: 0.42, height: 0.84 }] }), false);
  assert.equal(footprintBlocked(slab, { forEachNear: () => {}, cylinders: [{ x: 1, y: 2, z: 1, radius: 0.42, height: 0.84 }] }), false, '竖直不相交');

  const neighbourSlab = { collision: { shape: 'box', centerX: 0, centerZ: 0, halfWidth: 1, halfLength: 1, minimumY: 0, maximumY: 0.12 }, transform: { x: 3, y: 0, z: 1, yaw: 0 }, actorId: 'f2' };
  const visitAll = (instances) => (x, z, radius, visit) => instances.forEach(visit);
  assert.equal(footprintBlocked(slab, { forEachNear: visitAll([neighbourSlab]) }), false, '边缘相触不算');
  const tree = { collision: { shape: 'cylinder', centerX: 0, centerZ: 0, halfWidth: 0.3, halfLength: 0.3, minimumY: 0, maximumY: 3 }, transform: { x: 1.5, y: 0, z: 1.5, yaw: 0 } };
  assert.equal(footprintBlocked(slab, { forEachNear: visitAll([tree]) }), true);
  // 同一表面上已有的建造件由 ignore 排除；别的东西照挡。
  assert.equal(footprintBlocked(slab, {
    forEachNear: visitAll([{ ...tree, actorId: 'w1' }]),
    identify: (instance) => instance.actorId,
    ignore: (actorId) => actorId === 'w1',
  }), false);
  const wall = pieceFootprint({ x: 1, z: 2, yaw: 0 }, { halfWidth: 1, halfLength: 0.09, minimumY: 0, maximumY: 1.5 }, 0.12);
  assert.equal(footprintBlocked(wall, { forEachNear: visitAll([{ ...neighbourSlab, transform: { x: 1, y: 0, z: 1, yaw: 0 } }]) }), false, '墙脚落在地基顶面上');
});
