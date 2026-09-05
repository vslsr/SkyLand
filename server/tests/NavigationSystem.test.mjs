import assert from 'node:assert/strict';
import test from 'node:test';
import './initRapier.mjs';
import {
  INVENTORY_COMPONENT,
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
