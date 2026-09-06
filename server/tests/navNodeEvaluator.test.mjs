import assert from 'node:assert/strict';
import test from 'node:test';
import { CollisionWorld } from '../../shared/collision/index.mjs';
import { COLLISION_LAYER_SOLID } from '../../shared/collision/collisionLayers.mjs';
import {
  NAV_CELL_SIZE,
  NAV_NODE,
  classifyNavCell,
  createNavProfile,
  createNavigationContext,
  navCellCenter,
  navEdgeBlocked,
} from '../../shared/navigation/index.mjs';
import {
  TERRAIN_SHAPE,
  TERRAIN_SURFACE,
} from '../../shared/world/terrainConfig.mjs';
import { encodeTerrainCell } from '../../shared/world/terrainContent.mjs';

/**
 * NodeEvaluator 的全部工作是回答「这一格是什么」。这里逐条钉住它读到的三层：
 * 地形、建筑块、实心碰撞体——以及第四条边界，活动范围。
 */

/** 一张按坐标查表的地形；表里没写的格子是 0 层平坦陆地。 */
function terrainFrom(cells) {
  return (cellX, cellZ) => cells.get(`${cellX},${cellZ}`)
    ?? encodeTerrainCell(0, TERRAIN_SURFACE.GROUND, TERRAIN_SHAPE.FLAT);
}

test('平地是 WALKABLE，斜坡是 SLOPE，水是 WATER，出界是 BLOCKED', () => {
  // 斜坡和水各自离得远一点：一格只有一个类型，挨在一起的话斜坡会被记成岸边
  // （见 `classifyNavCell` 里那一条），而这一条用例要分别钉住两者。
  const cells = new Map([
    ['1,0', encodeTerrainCell(0, TERRAIN_SURFACE.GROUND, TERRAIN_SHAPE.RAMP_EAST)],
    ['5,0', encodeTerrainCell(-1, TERRAIN_SURFACE.WATER, TERRAIN_SHAPE.FLAT)],
  ]);
  const context = createNavigationContext({
    cellCodeAt: terrainFrom(cells),
    seaLevel: -0.4,
    bounds: { minimumX: -20, maximumX: 20, minimumZ: -20, maximumZ: 20 },
  });
  const profile = createNavProfile({});

  assert.equal(classifyNavCell(context, profile, 0, 0).type, NAV_NODE.WALKABLE);
  assert.equal(classifyNavCell(context, profile, 1, 0).type, NAV_NODE.SLOPE);
  assert.equal(classifyNavCell(context, profile, 5, 0).type, NAV_NODE.WATER);
  // 活动范围外的格子没有内容可言，不管它的地形长什么样。范围是米，格心在
  // (2n+1)/2 × 格宽 上，所以第 10 格的格心 x=21 已经出了 ±20 的活动范围。
  assert.equal(classifyNavCell(context, profile, 10, 0).type, NAV_NODE.BLOCKED);
});

test('水只对会游的开放；岸边一格罚得更贵，好让陆生 AI 往内陆绕', () => {
  const cells = new Map([['2,0', encodeTerrainCell(-1, TERRAIN_SURFACE.WATER, TERRAIN_SHAPE.FLAT)]]);
  const context = createNavigationContext({ cellCodeAt: terrainFrom(cells), seaLevel: -0.4 });
  const walker = createNavProfile({});
  const swimmer = createNavProfile({ swim: true });

  assert.ok(walker.malus[NAV_NODE.WATER] < 0, '不会游的把水当墙');
  assert.ok(swimmer.malus[NAV_NODE.WATER] >= 0, '会游的能下水');
  // 挨着水的那一格仍然走得了，只是更贵——这是「宁可绕一格」而不是「走不了」。
  const shore = classifyNavCell(context, walker, 1, 0);
  assert.equal(shore.type, NAV_NODE.WATER_EDGE);
  assert.ok(walker.malus[NAV_NODE.WATER_EDGE] > walker.malus[NAV_NODE.WALKABLE]);
  assert.equal(classifyNavCell(context, walker, 4, 0).type, NAV_NODE.WALKABLE);
});

test('地基把水面上的一格抬成可走的甲板，站立高度取地基顶面', () => {
  const cells = new Map([['3,3', encodeTerrainCell(-1, TERRAIN_SURFACE.WATER, TERRAIN_SHAPE.FLAT)]]);
  const context = createNavigationContext({
    cellCodeAt: terrainFrom(cells),
    seaLevel: -0.4,
    foundationTopAt: (cellX, cellZ) => (cellX === 3 && cellZ === 3 ? 0.25 : undefined),
  });
  const walker = createNavProfile({});

  const deck = classifyNavCell(context, walker, 3, 3);
  assert.equal(deck.type, NAV_NODE.DECK, '铺了地基的水面是可以走的');
  assert.equal(deck.standY, 0.25, '站在地基顶面上，不是站在河床上');
  // 码头不算岸边：罚它等于让 AI 拒绝走自己的栈桥。
  assert.equal(context.foundationTopAt(4, 3), undefined);
});

test('墙占的是边不是格：格心照样站得住，但穿过那条边走不了', () => {
  const walls = new Set(['2,2,north']);
  const context = createNavigationContext({
    wallOnEdge: (cellX, cellZ, edge) => walls.has(`${cellX},${cellZ},${edge}`),
  });
  const walker = createNavProfile({});

  // 两侧的格子都还是平地——墙没有占住任何一格。
  assert.equal(classifyNavCell(context, walker, 2, 2).type, NAV_NODE.WALKABLE);
  assert.equal(classifyNavCell(context, walker, 2, 3).type, NAV_NODE.WALKABLE);
  // 但它把这两格之间那一次穿越挡住了，两个方向都挡。
  assert.equal(navEdgeBlocked(context, 2, 2, 2, 3), true);
  assert.equal(navEdgeBlocked(context, 2, 3, 2, 2), true);
  // 别的边不受影响，包括同一格的另外三条。
  assert.equal(navEdgeBlocked(context, 2, 2, 3, 2), false);
  assert.equal(navEdgeBlocked(context, 2, 2, 2, 1), false);
});

test('实心碰撞体让一格站不下，判据就是玩家控制器那一份圆形推出', () => {
  const collision = new CollisionWorld();
  const treeX = navCellCenter(5);
  const treeZ = navCellCenter(5);
  collision.setDynamic('tree', {
    collision: {
      shape: 'box',
      centerX: 0,
      centerZ: 0,
      halfWidth: 0.6,
      halfLength: 0.6,
      minimumY: 0,
      maximumY: 2,
    },
    transform: { x: treeX, y: 0, z: treeZ, yaw: 0 },
    layers: COLLISION_LAYER_SOLID,
  });
  const context = createNavigationContext({
    resolveCircle: (x, z, radius, verticalProfile) => (
      collision.resolveCircle({ x, z }, radius, { verticalProfile })
    ),
  });

  assert.equal(classifyNavCell(context, createNavProfile({}), 5, 5).type, NAV_NODE.BLOCKED);
  assert.equal(classifyNavCell(context, createNavProfile({}), 6, 5).type, NAV_NODE.WALKABLE);
  // 抬腿抬得过的矮东西不挡路：这一条完全由碰撞层的 maximumStepHeight 决定，
  // 寻路没有自己的第二套判据。
  collision.setDynamic('kerb', {
    collision: {
      shape: 'box',
      centerX: 0,
      centerZ: 0,
      halfWidth: 0.9,
      halfLength: 0.9,
      minimumY: 0,
      maximumY: 0.2,
    },
    transform: { x: navCellCenter(7), y: 0, z: navCellCenter(5), yaw: 0 },
    layers: COLLISION_LAYER_SOLID,
  });
  assert.equal(classifyNavCell(context, createNavProfile({ stepUp: 0.6 }), 7, 5).type, NAV_NODE.WALKABLE);
  assert.equal(classifyNavCell(context, createNavProfile({ stepUp: 0.05 }), 7, 5).type, NAV_NODE.BLOCKED);
});

test('危险物件把一格标成 DANGER：走得了，但贵得让人愿意绕开', () => {
  const context = createNavigationContext({
    isDangerCell: (cellX, cellZ) => cellX === 0 && cellZ === 0,
  });
  const profile = createNavProfile({});
  assert.equal(classifyNavCell(context, profile, 0, 0).type, NAV_NODE.DANGER);
  assert.ok(profile.malus[NAV_NODE.DANGER] > profile.malus[NAV_NODE.WALKABLE] + 1);
  assert.ok(profile.malus[NAV_NODE.DANGER] >= 0, '默认是「贵」而不是「走不了」');
});

test('导航格就是地形格与建造格，三套网格共用一个尺寸', () => {
  assert.equal(NAV_CELL_SIZE, 2);
  assert.equal(navCellCenter(0), 1);
  assert.equal(navCellCenter(-1), -1);
});
