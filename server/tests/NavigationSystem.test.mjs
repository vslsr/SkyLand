import assert from 'node:assert/strict';
import test from 'node:test';
import './initRapier.mjs';
import {
  INVENTORY_COMPONENT,
  MOVING_ENTITY_COMPONENT,
  NAVIGATION_COMPONENT,
  TRANSFORM_COMPONENT,
} from '../../shared/actor/index.mjs';
import { ActorCatalog } from '../actors/ActorCatalog.mjs';
import { NAVIGATION_HANDOVER_RADIUS, NavigationSystem } from '../actors/NavigationSystem.mjs';
import { ServerScene } from '../scene/ServerScene.mjs';
import { SceneCatalog } from '../scenes/SceneCatalog.mjs';

/**
 * 整条链路：原型 → Component → System → 权威 Transform。
 *
 * 这里刻意走真实的 `ServerScene`，因为寻路要证明的恰恰是「它看到的世界就是
 * 玩家走的世界」——地形、玩家刚放下的墙、把玩家推开的那些障碍。用一张假世界
 * 测得再绿，也证明不了这一条。
 */

const catalogPromise = SceneCatalog.load();
const actorCatalogPromise = ActorCatalog.load();

function createClock(startAt = 1_000_000) {
  let current = startAt;
  return { now: () => current, advance(seconds) { current += seconds * 1000; } };
}

async function createScene(sceneId = 'legged-slime') {
  const catalog = await catalogPromise;
  const definition = structuredClone(catalog.require(sceneId));
  const clock = createClock();
  const scene = new ServerScene(definition, { now: clock.now });
  return { scene, clock };
}

/**
 * 在流式大世界上摆几只猎手。
 *
 * 无边草原自己不摆 Actor（内容全是按种子推出来的），但寻路要证明的两件事——
 * 台阶地形和玩家现放的建筑块——只有在这张图上才同时成立，所以这里往它的场景
 * 数据里补上放置。补的是**已经过校验的原型**，和场景 JSON 里写一行是同一条路。
 */
async function createStreamingScene(placements) {
  const catalog = await catalogPromise;
  const actorCatalog = await actorCatalogPromise;
  const definition = structuredClone(catalog.require('open-world'));
  definition.actorArchetypes = [
    ...definition.actorArchetypes,
    structuredClone(actorCatalog.require('legged-slime-hunter')),
  ];
  definition.actors = placements.map((placement) => ({
    id: placement.id,
    archetypeId: 'legged-slime-hunter',
    parentActorId: null,
    localTransform: { position: [placement.x, 0, placement.z], yaw: 0 },
  }));
  const clock = createClock();
  const scene = new ServerScene(definition, { now: clock.now });
  return { scene, clock };
}

function hunters(scene) {
  return [...scene.actorWorld.query(NAVIGATION_COMPONENT, TRANSFORM_COMPONENT)];
}

/** 把权威位置直接挪到某个世界点上，模拟玩家走过去。 */
function placePlayer(player, x, z) {
  player.x = x;
  player.z = z;
}

function runTicks(scene, clock, count, stepSeconds = 1 / 20) {
  for (let index = 0; index < count; index += 1) {
    clock.advance(stepSeconds);
    scene.update();
  }
}

test('猎手闻到玩家就追过去；玩家走远了就放手', async () => {
  const { scene, clock } = await createScene();
  scene.addPlayer({ id: 'prey', name: '猎物', slot: 0 });
  const player = scene.players.get('prey');
  const [hunter] = hunters(scene);
  assert.ok(hunter, '骨骼腿史莱姆这张图上摆着会寻路的猎手');
  const agent = hunter.requireComponent(NAVIGATION_COMPONENT);
  const transform = hunter.requireComponent(TRANSFORM_COMPONENT);

  // 站在察觉半径之外：它该照旧巡逻，不该有目标。
  placePlayer(player, 14, 8);
  runTicks(scene, clock, 5);
  assert.equal(agent.hasGoal, false, '看不见的人不追');

  // 走进察觉半径。
  placePlayer(player, transform.x + 6, transform.z);
  const startDistance = Math.hypot(player.x - transform.x, player.z - transform.z);
  runTicks(scene, clock, 40);
  const closed = Math.hypot(player.x - transform.x, player.z - transform.z);
  assert.equal(agent.hasGoal, true, '进了察觉半径就锁上目标');
  assert.ok(closed < startDistance - 2, `应当逼近，从 ${startDistance.toFixed(2)} 到 ${closed.toFixed(2)}`);

  // 追到 keepDistance 就停下：不再往前挤，但目标仍然锁着。
  runTicks(scene, clock, 40);
  const held = Math.hypot(player.x - transform.x, player.z - transform.z);
  assert.ok(held >= agent.chase.keepDistance - 0.6, `不该挤进目标身体里，实际 ${held.toFixed(2)}`);

  // 走出放弃半径：目标松开，巡逻接管。
  placePlayer(player, transform.x + 40, transform.z + 40);
  runTicks(scene, clock, 5);
  assert.equal(agent.hasGoal, false, '追出放弃半径就收手');
  assert.equal(agent.driving, false, '收手之后把方向盘还给巡逻');
});

test('玩家在猎手面前放下一堵墙：手上那条路当场作废，改从墙头绕', async () => {
  // 建筑块只在提供了它们的图上存在，而那正是流式大世界这一张。
  const { scene, clock } = await createStreamingScene([{ id: 'hunter-a', x: -5, z: 1 }]);
  scene.addPlayer({ id: 'builder', name: '工匠', slot: 0 });
  const player = scene.players.get('builder');
  player.getComponent(INVENTORY_COMPONENT).add('wood', 40);
  const [hunter] = hunters(scene);
  const agent = hunter.requireComponent(NAVIGATION_COMPONENT);
  const transform = hunter.requireComponent(TRANSFORM_COMPONENT);

  // 玩家正东 6 米，中间没有东西：这条路应当笔直。
  placePlayer(player, transform.x + 6, transform.z);
  runTicks(scene, clock, 3);
  assert.ok(agent.hasPath, '先有一条路');
  const revisionBefore = scene.navigation.context.revision;

  // 在两者之间那一格的东侧边上放一堵墙。放置走的是玩家那条权威命令，不是
  // 测试自己往占位表里塞记录——两端看到的必须是同一堵墙。
  const wallCellX = Math.floor((transform.x + 3) / 2);
  const wallCellZ = Math.floor(transform.z / 2);
  const placed = scene.applyBuildCommand('builder', {
    sequence: 1,
    command: {
      kind: 'place',
      archetypeId: 'wood-wall',
      surface: 'static',
      cellX: wallCellX,
      cellZ: wallCellZ,
      edge: 'east',
    },
  });
  assert.equal(placed, true, '墙放下了');
  assert.equal(
    scene.buildSites.at('static', wallCellX, wallCellZ, 'east')?.kind,
    'wall',
    '占位表上记着这条边',
  );
  assert.notEqual(scene.navigation.refresh().revision, revisionBefore, '世界的版本号跟着变');
  assert.equal(agent.needsRepath(scene.navigation.context.revision), true, '旧路当场作废');

  runTicks(scene, clock, 3);
  assert.ok(agent.hasPath, '重寻之后仍然有路');

  // 断言的是**走出来的轨迹**而不是路径的节点表：平滑之后一段可以横跨好几格，
  // 只看端点会把「从墙头上方绕过去」误判成穿墙。逐 tick 采权威位置，位移
  // 远小于一格，跨格因此一次只跨一条边——那正好是要检查的东西。
  const startDistance = Math.hypot(player.x - transform.x, player.z - transform.z);
  let previousCellX = Math.floor(transform.x / 2);
  let previousCellZ = Math.floor(transform.z / 2);
  for (let index = 0; index < 60; index += 1) {
    runTicks(scene, clock, 1);
    const cellX = Math.floor(transform.x / 2);
    const cellZ = Math.floor(transform.z / 2);
    const crossedWalledEdge = previousCellZ === wallCellZ && cellZ === wallCellZ
      && Math.min(previousCellX, cellX) === wallCellX
      && Math.max(previousCellX, cellX) === wallCellX + 1;
    assert.equal(crossedWalledEdge, false, '一只会寻路的生物不该从墙里穿过去');
    previousCellX = cellX;
    previousCellZ = cellZ;
  }
  const endDistance = Math.hypot(player.x - transform.x, player.z - transform.z);
  assert.ok(
    endDistance < startDistance - 1,
    `绕过去之后仍然要逼近，从 ${startDistance.toFixed(2)} 到 ${endDistance.toFixed(2)}`,
  );
});

test('每 tick 只放固定次数的搜索过去，轮转排队不让谁饿死', async () => {
  const { scene, clock } = await createScene();
  scene.addPlayer({ id: 'prey', name: '猎物', slot: 0 });
  const player = scene.players.get('prey');
  const system = scene.actorWorld.systems.find((entry) => entry instanceof NavigationSystem);
  assert.ok(system, 'NavigationSystem 进了 tick');
  assert.equal(system.searchesPerTick, 2);

  const all = hunters(scene);
  assert.ok(all.length >= 2, '这张图上不止一只会寻路的');
  // 把所有猎手挪到玩家身边，让它们同时想找路。
  placePlayer(player, 0, 0);
  for (const [index, hunter] of all.entries()) {
    hunter.requireComponent(TRANSFORM_COMPONENT).setWorldTransform([index * 2 - 3, 0, -6], 0);
  }
  runTicks(scene, clock, 1);
  assert.ok(
    system.searchesThisTick <= system.searchesPerTick,
    `一 tick 最多 ${system.searchesPerTick} 次搜索，实际 ${system.searchesThisTick}`,
  );

  // 转一圈之后每只都该拿到过一次搜索机会。
  runTicks(scene, clock, all.length + 2);
  for (const hunter of all) {
    const agent = hunter.requireComponent(NAVIGATION_COMPONENT);
    assert.ok(agent.hasPath || agent.hasGoal, '轮转不该把谁一直排在队尾');
  }
});

test('房间里没有玩家时一只生物都不寻路：成本随人走，不随世界面积走', async () => {
  const { scene, clock } = await createScene();
  const system = scene.actorWorld.systems.find((entry) => entry instanceof NavigationSystem);
  runTicks(scene, clock, 10);
  assert.equal(system.searchesThisTick, 0, '没人看的地方不想事情');
  assert.equal(system.pathfinder.allocatedCells, 0, '连工作数组都不必分配');

  // 有人进来了，但站在活动半径之外：照样不寻路。
  scene.addPlayer({ id: 'far', name: '远客', slot: 0 });
  placePlayer(scene.players.get('far'), 900, 900);
  runTicks(scene, clock, 5);
  assert.equal(system.searchesThisTick, 0, '活动半径之外的生物不排队');
});

test('搜索窗口按场景原型开一次，走出两万米也不再涨', async () => {
  const { scene, clock } = await createStreamingScene([{ id: 'hunter-a', x: 0, z: 0 }]);
  const system = scene.actorWorld.systems.find((entry) => entry instanceof NavigationSystem);
  scene.addPlayer({ id: 'walker', name: '远行者', slot: 0 });
  const player = scene.players.get('walker');
  const [hunter] = hunters(scene);
  const transform = hunter.requireComponent(TRANSFORM_COMPONENT);
  const agent = hunter.requireComponent(NAVIGATION_COMPONENT);

  placePlayer(player, 5, 0);
  runTicks(scene, clock, 4);
  // 窗口半径来自原型的 searchRadiusCells（16），不是运行时最先寻路的那一只
  // 碰巧要多少就开多少。
  assert.equal(agent.profile.searchRadiusCells, 16);
  assert.equal(system.pathfinder.allocatedCells, 33 * 33);
  const allocated = system.pathfinder.allocatedCells;

  // 把这一对挪到两万米之外再走一遍：窗口跟着人挪，内存不跟着里程涨。
  for (const distance of [4_000, 12_000, 20_000]) {
    transform.setWorldTransform([distance, transform.y, -distance], 0);
    placePlayer(player, distance + 5, -distance);
    agent.clearGoal();
    runTicks(scene, clock, 6);
    assert.equal(
      system.pathfinder.allocatedCells,
      allocated,
      `走到 ${distance} 米之后工作内存不该变`,
    );
    assert.equal(agent.hasGoal, true, '远方的生物照样闻得到身边的玩家');
  }
});

test('追完之后自己走回岗位再交还巡逻，全程不瞬移一步', async () => {
  const { scene, clock } = await createScene();
  scene.addPlayer({ id: 'prey', name: '猎物', slot: 0 });
  const player = scene.players.get('prey');
  const [hunter] = hunters(scene);
  const agent = hunter.requireComponent(NAVIGATION_COMPONENT);
  const transform = hunter.requireComponent(TRANSFORM_COMPONENT);

  // 逐 tick 采权威位置，记下最大的一次位移。一次瞬移就会在这里显形——巡逻按
  // 自己冻结的进度把生物拽回路线时，那一步会是好几米。
  const stepSeconds = 1 / 20;
  let maximumStep = 0;
  let previousX = transform.x;
  let previousZ = transform.z;
  const advance = (ticks) => {
    for (let index = 0; index < ticks; index += 1) {
      runTicks(scene, clock, 1, stepSeconds);
      maximumStep = Math.max(maximumStep, Math.hypot(transform.x - previousX, transform.z - previousZ));
      previousX = transform.x;
      previousZ = transform.z;
    }
  };

  // 巡逻两秒 → 被引出去追 → 追到面前站定 → 玩家退到放弃半径之外 → 走回岗位。
  placePlayer(player, transform.x + 40, transform.z + 40);
  advance(40);
  placePlayer(player, transform.x + 7, transform.z + 4);
  advance(80);
  assert.equal(agent.hasGoal, true, '这时候应当正咬着目标');
  // 退到放弃半径之外，但仍在活动半径之内：让位必须发生在有人看着的时候。
  placePlayer(player, transform.x + 25, transform.z);
  advance(120);
  assert.equal(agent.driving, false, '回到岗位之后把方向盘还给巡逻');
  advance(40);

  // 上界：这只生物一 tick 走得动的距离，外加交接那一步的上界。除了这两项，
  // 没有任何东西该让权威位置跳一下。
  const perTickLimit = agent.speed * stepSeconds + NAVIGATION_HANDOVER_RADIUS + 1e-6;
  assert.ok(
    maximumStep <= perTickLimit,
    `任何一 tick 的位移都不该超过它自己走得动的距离：${maximumStep.toFixed(3)} > ${perTickLimit.toFixed(3)}`,
  );
});

test('两只猎手追同一个玩家不会叠在一起：一只让开，两只都追得上', async () => {
  // 搜索给的两条路都是最优的，而且几乎重合——A* 不认识别的会走路的生物。
  // 局部避障要证明的就是这一条：路不变，走起来不挤。
  const { scene, clock } = await createStreamingScene([
    { id: 'hunter-a', x: 0, z: 0 },
    { id: 'hunter-b', x: 0.6, z: 0 },
  ]);
  scene.addPlayer({ id: 'prey', name: '猎物', slot: 0 });
  const player = scene.players.get('prey');
  const pack = hunters(scene);
  assert.equal(pack.length, 2);
  const [first, second] = pack.map((actor) => actor.requireComponent(TRANSFORM_COMPONENT));
  const startGap = Math.hypot(first.x - second.x, first.z - second.z);

  placePlayer(player, 14, 0);
  let tightest = Infinity;
  for (let tick = 0; tick < 120; tick += 1) {
    runTicks(scene, clock, 1);
    tightest = Math.min(tightest, Math.hypot(first.x - second.x, first.z - second.z));
  }

  // 两个半径之和是 0.8 米。允许贴近，但不许穿模成一只——那正是没有避障时的样子。
  assert.ok(tightest > 0.4, `最近时也该留着间距，实际 ${tightest.toFixed(3)} 米`);
  assert.ok(startGap > 0, '出发时本来就分开站着');
  for (const transform of [first, second]) {
    assert.ok(
      Math.hypot(player.x - transform.x, player.z - transform.z) < 4,
      '让路不是不追了：两只都该走到玩家跟前',
    );
  }
});

test('挤在一起站定的两只会慢慢挪开，而不是重叠成一坨', async () => {
  const { scene, clock } = await createStreamingScene([
    { id: 'hunter-a', x: 0, z: 0 },
    { id: 'hunter-b', x: 0.1, z: 0 },
  ]);
  scene.addPlayer({ id: 'prey', name: '猎物', slot: 0 });
  const player = scene.players.get('prey');
  const [first, second] = hunters(scene).map((actor) => actor.requireComponent(TRANSFORM_COMPONENT));

  // 玩家站在两只中间：它们都已经到了 keepDistance 之内，手上都没有路，
  // 只有「站定时互相推开」这一条还在起作用。
  placePlayer(player, 0.05, 0);
  const before = Math.hypot(first.x - second.x, first.z - second.z);
  runTicks(scene, clock, 60);
  const after = Math.hypot(first.x - second.x, first.z - second.z);
  assert.ok(after > before, `站定的两只该挪开，${before.toFixed(3)} → ${after.toFixed(3)}`);
});

test('玩家也是实体：生物绕着他走，而他一步都不被推着动', async () => {
  // 实体（`MovingEntityComponent`）是「频繁移动的对象」这一层最基础的类型，
  // 生物和玩家挂的是同一个。玩家写着 `avoidCrowd: false`——方向盘永远在他自己
  // 手里——但他仍然在避障那张表里，生物这才会从他身边让开而不是径直穿过他。
  const { scene, clock } = await createStreamingScene([{ id: 'hunter-a', x: 0, z: 0 }]);
  scene.addPlayer({ id: 'prey', name: '猎物', slot: 0 });
  const player = scene.players.get('prey');
  const [hunter] = hunters(scene);
  const transform = hunter.requireComponent(TRANSFORM_COMPONENT);
  assert.ok(
    player.getComponent(MOVING_ENTITY_COMPONENT),
    '玩家挂着实体层：他是别人要绕开的那个圆',
  );
  assert.equal(
    player.getComponent(MOVING_ENTITY_COMPONENT).avoidsCrowd,
    false,
    '玩家自己不让路',
  );
  assert.ok(hunter.getComponent(MOVING_ENTITY_COMPONENT), '会寻路的自动带一个实体层');

  // 把猎手和玩家叠在一起：猎手已经在 keepDistance 之内，手上没有路，只有实体
  // 之间的互相推开还在起作用。
  placePlayer(player, 0.05, 0);
  const playerBefore = { x: player.x, z: player.z };
  const overlapBefore = Math.hypot(player.x - transform.x, player.z - transform.z);
  runTicks(scene, clock, 60);
  const overlapAfter = Math.hypot(player.x - transform.x, player.z - transform.z);

  assert.ok(overlapAfter > overlapBefore, `猎手该从玩家身上挪开，${overlapBefore.toFixed(3)} → ${overlapAfter.toFixed(3)}`);
  assert.equal(player.x, playerBefore.x, '玩家一步都不该被避障推动');
  assert.equal(player.z, playerBefore.z);
});
