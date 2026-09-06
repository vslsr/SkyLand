import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_NAV_SEARCH_RADIUS_CELLS,
  NAV_NODE,
  NavPathfinder,
  createNavProfile,
  createNavigationContext,
  navLineWalkable,
  smoothNavPath,
} from '../../shared/navigation/index.mjs';
import {
  TERRAIN_SHAPE,
  TERRAIN_SURFACE,
} from '../../shared/world/terrainConfig.mjs';
import { encodeTerrainCell } from '../../shared/world/terrainContent.mjs';

/**
 * A* 本体。这里全部用手写的格子表而不是真实地形：要钉住的是「墙挡不挡得住」
 * 「找不到路时交出什么」「预算封不封得住」，让世界生成参与进来只会让失败原因
 * 变得含糊。
 */

function cellsOf(path) {
  return path.nodes.map((node) => `${node.cellX},${node.cellZ}`);
}

/** `blocked` 里的格子站不住；`walls` 里的边过不去。 */
function scenarioContext({ blocked = new Set(), walls = new Set(), cells } = {}) {
  return createNavigationContext({
    cellCodeAt: cells
      ? (cellX, cellZ) => cells.get(`${cellX},${cellZ}`)
        ?? encodeTerrainCell(0, TERRAIN_SURFACE.GROUND, TERRAIN_SHAPE.FLAT)
      : undefined,
    wallOnEdge: (cellX, cellZ, edge) => walls.has(`${cellX},${cellZ},${edge}`),
    // 用碰撞那一路把格子标成走不通：这正是一棵树在真实世界里的效果。
    resolveCircle: (x, z, radius) => (
      blocked.has(`${Math.floor(x / 2)},${Math.floor(z / 2)}`)
        ? { x: x + radius * 2, z }
        : { x, z }
    ),
  });
}

test('空地上走直线，节点全在起点和终点连成的那条线上', () => {
  const finder = new NavPathfinder({ radiusCells: 12 });
  const result = finder.findPath(
    scenarioContext(),
    createNavProfile({}),
    { cellX: 0, cellZ: 0 },
    { cellX: 6, cellZ: 0 },
  );
  assert.equal(result.reachedGoal, true);
  assert.deepEqual(cellsOf(result), ['0,0', '1,0', '2,0', '3,0', '4,0', '5,0', '6,0']);
  // 起点格也在路里：平滑那一层要拿它当第一个锚点。
  assert.equal(result.nodes[0].type, NAV_NODE.WALKABLE);
});

test('一堵墙横在中间，路径绕过墙头而不是穿墙而过', () => {
  // 沿 z=0 与 z=1 之间那条边立一排墙，只在 x=4 处留一个口子。
  const walls = new Set();
  for (let cellX = -3; cellX <= 3; cellX += 1) walls.add(`${cellX},0,north`);
  const context = scenarioContext({ walls });
  const finder = new NavPathfinder({ radiusCells: 16 });
  const result = finder.findPath(
    context,
    createNavProfile({}),
    { cellX: 0, cellZ: 0 },
    { cellX: 0, cellZ: 2 },
  );

  assert.equal(result.reachedGoal, true, '有口子就该走得过去');
  const crossings = result.nodes.slice(1).filter((node, index) => {
    const previous = result.nodes[index];
    return previous.cellZ === 0 && node.cellZ === 1;
  });
  for (const crossing of crossings) {
    assert.ok(Math.abs(crossing.cellX) > 3, `不该从 x=${crossing.cellX} 穿墙`);
  }
  // 绕路一定比直着走远：这就是那堵墙的代价。
  assert.ok(result.nodes.length > 3, `绕路应当更长，实际 ${result.nodes.length} 个节点`);
});

test('墙把目标彻底围死时，交出通往最近点的那一条路而不是空手而归', () => {
  // 把 (0,0) 四面围起来，AI 站在外面。
  const walls = new Set(['0,0,north', '0,-1,north', '0,0,east', '-1,0,east']);
  const finder = new NavPathfinder({ radiusCells: 10 });
  const result = finder.findPath(
    scenarioContext({ walls }),
    createNavProfile({}),
    { cellX: 4, cellZ: 0 },
    { cellX: 0, cellZ: 0 },
  );

  assert.equal(result.reachedGoal, false, '进不去就是进不去');
  assert.ok(result.nodes.length > 1, '仍然要给出一条能走的路');
  const last = result.nodes[result.nodes.length - 1];
  // 走到墙根前停下：一只站在原地不动的生物看起来是坏了，走到墙前停下的
  // 那只看起来是被墙拦住了。
  assert.ok(
    Math.max(Math.abs(last.cellX), Math.abs(last.cellZ)) <= 1,
    `应当停在目标旁边，实际停在 ${last.cellX},${last.cellZ}`,
  );
});

test('节点预算封住最坏情况：搜索停在上限上，并且仍然交出一条路', () => {
  const finder = new NavPathfinder({ radiusCells: MAX_NAV_SEARCH_RADIUS_CELLS });
  const profile = createNavProfile({ maxVisitedNodes: 40, searchRadiusCells: 40 });
  // 目标远在窗口之外，A* 只能一路铺开，直到预算用完。
  const result = finder.findPath(
    scenarioContext(),
    profile,
    { cellX: 0, cellZ: 0 },
    { cellX: 400, cellZ: 400 },
  );

  assert.equal(result.reachedGoal, false);
  assert.ok(result.visitedNodes <= 40, `展开数应当不超过预算，实际 ${result.visitedNodes}`);
  assert.ok(result.nodes.length > 1, '朝目标方向先走一段仍然是有用的一步');
});

test('搜索半径就是这只生物的视野：窗口之外一律走不到', () => {
  const finder = new NavPathfinder({ radiusCells: 24 });
  const near = createNavProfile({ searchRadiusCells: 4 });
  const far = createNavProfile({ searchRadiusCells: 20 });
  const context = scenarioContext();
  const goal = { cellX: 10, cellZ: 0 };

  assert.equal(finder.findPath(context, near, { cellX: 0, cellZ: 0 }, goal).reachedGoal, false);
  assert.equal(finder.findPath(context, far, { cellX: 0, cellZ: 0 }, goal).reachedGoal, true);
});

test('斜着穿过格角要两侧都开着：夹在两个障碍之间的缝走不过去', () => {
  // 把 (0,0) 和 (1,1) 各自封成一个只剩对角相邻的口袋：两者之间唯一可能的
  // 一步就是那条对角缝，而缝的两侧 (1,0) 与 (0,1) 都被堵着。
  const blocked = new Set([
    '1,0', '-1,0', '0,1', '0,-1', '1,-1', '-1,1', '-1,-1',
    '2,1', '1,2', '2,2', '2,0', '0,2',
  ]);
  const finder = new NavPathfinder({ radiusCells: 8 });
  const profile = createNavProfile({});
  const result = finder.findPath(
    scenarioContext({ blocked }),
    profile,
    { cellX: 0, cellZ: 0 },
    { cellX: 1, cellZ: 1 },
  );
  assert.equal(result.reachedGoal, false, '两侧都堵着时那条对角缝不算通路');
  assert.deepEqual(cellsOf(result), ['0,0'], '一步都走不出去');

  // 同一张图，把缝的一侧让开：这一步立刻走得通，而且走的是正交两步而不是
  // 硬挤那个角。
  blocked.delete('1,0');
  const opened = finder.findPath(
    scenarioContext({ blocked }),
    profile,
    { cellX: 0, cellZ: 0 },
    { cellX: 1, cellZ: 1 },
  );
  assert.equal(opened.reachedGoal, true);
  assert.deepEqual(cellsOf(opened), ['0,0', '1,0', '1,1']);
});

test('台阶迈得上去，断崖跳不下来', () => {
  const cells = new Map([
    ['1,0', encodeTerrainCell(1, TERRAIN_SURFACE.GROUND, TERRAIN_SHAPE.FLAT)],
    ['2,0', encodeTerrainCell(1, TERRAIN_SURFACE.GROUND, TERRAIN_SHAPE.FLAT)],
  ]);
  const context = scenarioContext({ cells });
  const finder = new NavPathfinder({ radiusCells: 8 });

  const climber = createNavProfile({ stepUp: 1.05, maxDrop: 1.5 });
  assert.equal(
    finder.findPath(context, climber, { cellX: 0, cellZ: 0 }, { cellX: 2, cellZ: 0 }).reachedGoal,
    true,
    '抬得起腿的就上得去',
  );

  const shortLegs = createNavProfile({ stepUp: 0.4, maxDrop: 0.4 });
  const blockedPath = finder.findPath(
    context,
    shortLegs,
    { cellX: 0, cellZ: 0 },
    { cellX: 2, cellZ: 0 },
  );
  assert.equal(blockedPath.reachedGoal, false, '一米的台阶对短腿就是一堵墙');
});

test('平滑把楼梯拉成直线，但绝不拉过一堵 A* 明确绕开的墙', () => {
  const finder = new NavPathfinder({ radiusCells: 12 });
  const openContext = scenarioContext();
  const profile = createNavProfile({});
  const open = finder.findPath(openContext, profile, { cellX: 0, cellZ: 0 }, { cellX: 8, cellZ: 3 });
  const straightened = smoothNavPath(finder.region, openContext, profile, open.nodes);
  assert.deepEqual(cellsOf({ nodes: straightened }), ['0,0', '8,3'], '空地上只剩两端');

  const walls = new Set();
  for (let cellX = -3; cellX <= 3; cellX += 1) walls.add(`${cellX},0,north`);
  const walledContext = scenarioContext({ walls });
  const detour = finder.findPath(
    walledContext,
    profile,
    { cellX: 0, cellZ: 0 },
    { cellX: 0, cellZ: 2 },
  );
  const smoothed = smoothNavPath(finder.region, walledContext, profile, detour.nodes);
  assert.ok(smoothed.length >= 3, '绕墙的路不能被拉成一条直线');
  for (let index = 1; index < smoothed.length; index += 1) {
    assert.equal(
      navLineWalkable(
        finder.region,
        walledContext,
        profile,
        smoothed[index - 1].cellX,
        smoothed[index - 1].cellZ,
        smoothed[index].cellX,
        smoothed[index].cellZ,
      ),
      true,
      '平滑后的每一段仍然要走得通',
    );
  }
});

test('工作内存只跟窗口走：没人寻路时一个字节都不占，寻过之后也不再涨', () => {
  const finder = new NavPathfinder({ radiusCells: 20 });
  assert.equal(finder.allocatedCells, 0, '懒分配：没有会寻路的 Actor 就不开数组');

  const context = scenarioContext();
  const profile = createNavProfile({ searchRadiusCells: 20 });
  finder.findPath(context, profile, { cellX: 0, cellZ: 0 }, { cellX: 12, cellZ: 9 });
  const allocated = finder.allocatedCells;
  assert.equal(allocated, 41 * 41);

  // 走出去两万格再寻一次：窗口跟着人挪，内存不跟着世界涨。
  finder.findPath(context, profile, { cellX: 20_000, cellZ: -9_000 }, { cellX: 20_012, cellZ: -8_991 });
  assert.equal(finder.allocatedCells, allocated);
});

test('分类结果在同一次搜索里只算一次，也不会跨世界版本被复用', () => {
  const finder = new NavPathfinder({ radiusCells: 6 });
  const profile = createNavProfile({});
  let classifications = 0;
  const context = createNavigationContext({
    resolveCircle: (x, z) => {
      classifications += 1;
      return { x, z };
    },
  });

  finder.findPath(context, profile, { cellX: 0, cellZ: 0 }, { cellX: 3, cellZ: 0 });
  const firstPass = classifications;
  assert.ok(firstPass <= finder.allocatedCells, '一格最多分类一次');

  // 同一个版本、同一个窗口、同一个体型：缓存整份留用。
  classifications = 0;
  finder.findPath(context, profile, { cellX: 0, cellZ: 0 }, { cellX: 3, cellZ: 0 });
  assert.equal(classifications, 0, '重复搜索不该重新分类');

  // 有人盖了墙（版本号变了）：缓存必须整份作废。
  context.revision += 1;
  classifications = 0;
  finder.findPath(context, profile, { cellX: 0, cellZ: 0 }, { cellX: 3, cellZ: 0 });
  assert.ok(classifications > 0, '世界变了就要重新看一遍');
});
