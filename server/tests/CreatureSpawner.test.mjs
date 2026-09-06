import assert from 'node:assert/strict';
import test from 'node:test';
import './initRapier.mjs';
import { HEALTH_COMPONENT, TRANSFORM_COMPONENT } from '../../shared/actor/index.mjs';
import { ServerScene } from '../scene/ServerScene.mjs';
import { SceneCatalog } from '../scenes/SceneCatalog.mjs';
import { isCreatureChunk } from '../../shared/world/creatureSpawn.mjs';
import { toChunkCoordinate } from '../../shared/world/chunkKey.mjs';

/**
 * 刷新的调度那一半。走真实的 `ServerScene`，因为要证明的正是「刷出来的是世界里
 * 一件真东西」：它落在权威地形上、进快照、被打死之后配额跟着放回来。
 */

const catalogPromise = SceneCatalog.load();

function createClock(startAt = 1_000_000) {
  let current = startAt;
  return { now: () => current, advance(seconds) { current += seconds * 1000; } };
}

async function createScene(mutate = (definition) => definition) {
  const catalog = await catalogPromise;
  const definition = mutate(structuredClone(catalog.require('legged-slime')));
  const clock = createClock();
  const scene = new ServerScene(definition, { now: clock.now });
  return { scene, clock, rule: definition.gameplay.creatureSpawns[0] };
}

function runTicks(scene, clock, count, stepSeconds = 0.1) {
  for (let index = 0; index < count; index += 1) {
    clock.advance(stepSeconds);
    scene.update();
  }
}

function spawnedActors(scene) {
  return [...scene.actorWorld.actors()].filter((actor) => actor.id.startsWith('spawn-'));
}

function placePlayer(player, x, z) {
  player.x = x;
  player.z = z;
}

test('骨骼腿史莱姆图刷的是绿色的那一种，落在玩家周围的圆环里', async () => {
  const { scene, clock, rule } = await createScene();
  assert.equal(rule.archetypeId, 'green-legged-slime');
  scene.addPlayer({ id: 'p1', name: '猎物', slot: 0 });
  const player = scene.players.get('p1');
  placePlayer(player, 0, 0);
  runTicks(scene, clock, 600);

  const spawned = spawnedActors(scene);
  assert.ok(spawned.length > 0, '跑够几个周期总该刷出来一些');
  for (const actor of spawned) {
    assert.equal(actor.archetypeId, 'green-legged-slime');
    const transform = actor.requireComponent(TRANSFORM_COMPONENT);
    const distance = Math.hypot(transform.x - player.x, transform.z - player.z);
    // 成群刷新会让同伴散开一点，所以内圈留出散开半径的余量。
    assert.ok(distance >= rule.minimumDistance - 3, `不该刷在脸上，实际 ${distance.toFixed(1)}`);
    assert.ok(distance <= rule.maximumDistance + 3, `不该刷在够不着的地方，实际 ${distance.toFixed(1)}`);
  }
});

test('刷出来的都是绿色：颜色写在原型上，不是刷新时挑的', async () => {
  const catalog = await catalogPromise;
  const definition = catalog.require('legged-slime');
  const archetype = definition.actorArchetypes.find((each) => each.id === 'green-legged-slime');
  assert.ok(archetype, '刷新引用的原型自动进了场景原型表，不用在 runtimeActorArchetypes 里重复写');
  const render = archetype.components.render;
  assert.equal(render.model, 'line-art-legged-slime');
  // 膜、中层、核三层都要落在绿色那一侧，否则「绿史莱姆」只是名字绿。
  for (const key of ['membraneColor', 'middleColor', 'coreColor']) {
    const color = render[key];
    const red = Number.parseInt(color.slice(1, 3), 16);
    const green = Number.parseInt(color.slice(3, 5), 16);
    const blue = Number.parseInt(color.slice(5, 7), 16);
    assert.ok(green > red && green > blue, `${key} = ${color} 不是绿的`);
  }
});

test('只在刷新区块里刷：出怪的地图和世界一样是种子的纯函数', async () => {
  const { scene, clock, rule } = await createScene();
  assert.ok(rule.chunkOneIn > 1, '这条用例要的就是「不是每个 chunk 都出」');
  scene.addPlayer({ id: 'p1', name: '猎物', slot: 0 });
  const player = scene.players.get('p1');

  // 换几个位置多刷几轮，样本才盖得住不止一个 chunk。
  const checked = new Set();
  for (const [x, z] of [[0, 0], [120, -80], [-260, 340]]) {
    placePlayer(player, x, z);
    runTicks(scene, clock, 600);
    for (const actor of spawnedActors(scene)) {
      const transform = actor.requireComponent(TRANSFORM_COMPONENT);
      const chunkX = toChunkCoordinate(transform.x);
      const chunkZ = toChunkCoordinate(transform.z);
      checked.add(`${chunkX},${chunkZ}`);
      assert.equal(
        isCreatureChunk(scene.worldSeed, chunkX, chunkZ, rule.chunkOneIn, rule.chunkSalt),
        true,
        `(${chunkX}, ${chunkZ}) 不是刷新区块，不该出怪`,
      );
    }
  }
  assert.ok(checked.size > 0, '至少要真的刷出来过');
});

test('配额封住数量：一个人一份，两个人也不超过全房间上限', async () => {
  const { scene, clock, rule } = await createScene();
  scene.addPlayer({ id: 'p1', name: '甲', slot: 0 });
  placePlayer(scene.players.get('p1'), 0, 0);
  // 逐 tick 盯着上限：刷满之后停下是这套机制的硬约束，「多久刷满」只是手感。
  // 一片刷不出东西的地（水多、树密、刷新区块少）本来就该刷得慢。
  const soloCap = Math.min(rule.capPerPlayer, rule.maximumPerRoom);
  let peak = 0;
  for (let index = 0; index < 3000; index += 1) {
    runTicks(scene, clock, 1);
    peak = Math.max(peak, scene.creatureSpawner.liveCount);
    assert.ok(peak <= soloCap, `一个人的房间不该超过 ${soloCap}，实际 ${peak}`);
  }
  assert.equal(peak, soloCap, '给够时间就该刷满');

  scene.addPlayer({ id: 'p2', name: '乙', slot: 1 });
  placePlayer(scene.players.get('p2'), 60, 60);
  const cap = Math.min(rule.capPerPlayer * 2, rule.maximumPerRoom);
  for (let index = 0; index < 2000; index += 1) {
    runTicks(scene, clock, 1);
    assert.ok(
      scene.creatureSpawner.liveCount <= cap,
      `两个人的配额是 ${cap}，实际 ${scene.creatureSpawner.liveCount}`,
    );
  }
  assert.ok(scene.creatureSpawner.liveCount > soloCap, '多一个人就多一份配额');
  assert.equal(scene.creatureSpawner.liveCount, spawnedActors(scene).length, '登记表和世界对得上');
});

test('打死一只，配额跟着放回来', async () => {
  const { scene, clock } = await createScene();
  scene.addPlayer({ id: 'p1', name: '猎人', slot: 0 });
  placePlayer(scene.players.get('p1'), 0, 0);
  runTicks(scene, clock, 900);
  const cap = scene.creatureSpawner.liveCount;
  assert.ok(cap > 0);

  const victim = spawnedActors(scene)[0];
  const health = victim.requireComponent(HEALTH_COMPONENT);
  scene.applyHealthChange(victim.id, -health.maximum);
  assert.equal(victim.getComponent(HEALTH_COMPONENT).dead, true);
  // 尸体停留几秒再由 HealthSystem 收走；配额要等它真的离开世界才算释放。
  runTicks(scene, clock, 100);
  assert.equal(scene.actorWorld.getActor(victim.id), undefined, '尸体已经被收走');
  assert.equal(
    spawnedActors(scene).some((actor) => actor.id === victim.id),
    false,
    '死掉的那只不再占着配额',
  );
  // 再给足几十个周期：空出来的那一格必须被填上。填不上说明配额被死掉的那只
  // 永远占着——那种房间打完一波就再也不出怪了。
  runTicks(scene, clock, 3000);
  assert.equal(scene.creatureSpawner.liveCount, cap, '配额重新被填满');
});

test('走远了旧的消失、新的在身边刷出来；房间空了一只都不留', async () => {
  const { scene, clock } = await createScene();
  scene.addPlayer({ id: 'p1', name: '远行者', slot: 0 });
  const player = scene.players.get('p1');
  placePlayer(player, 0, 0);
  runTicks(scene, clock, 600);
  const before = new Set(spawnedActors(scene).map((actor) => actor.id));
  assert.ok(before.size > 0);

  placePlayer(player, 600, 600);
  runTicks(scene, clock, 600);
  const survivors = spawnedActors(scene).filter((actor) => before.has(actor.id));
  assert.equal(survivors.length, 0, '走出一倍半刷新范围之后旧的一只都不该留着');

  scene.removePlayer('p1');
  runTicks(scene, clock, 200);
  assert.equal(scene.creatureSpawner.liveCount, 0, '没有人的房间不该留着一群等在那儿的怪');
  assert.equal(spawnedActors(scene).length, 0);
});

test('走在流式大世界里：两万米之外照样刷，数量仍然封在配额上', async () => {
  const { scene, clock, rule } = await createScene();
  scene.addPlayer({ id: 'p1', name: '远行者', slot: 0 });
  const player = scene.players.get('p1');
  for (const distance of [0, 5_000, 20_000]) {
    placePlayer(player, distance, -distance);
    runTicks(scene, clock, 600);
    assert.ok(
      scene.creatureSpawner.liveCount <= rule.capPerPlayer,
      `走到 ${distance} 米之后数量仍然要封在配额里，实际 ${scene.creatureSpawner.liveCount}`,
    );
    for (const actor of spawnedActors(scene)) {
      const transform = actor.requireComponent(TRANSFORM_COMPONENT);
      const away = Math.hypot(transform.x - player.x, transform.z - player.z);
      assert.ok(away <= rule.maximumDistance * 1.5, `远处的旧个体没被收走：${away.toFixed(1)}`);
    }
  }
});

test('没有配置刷新的地图一个字节都不花', async () => {
  const catalog = await catalogPromise;
  const clock = createClock();
  const scene = new ServerScene(structuredClone(catalog.require('open-world')), { now: clock.now });
  assert.equal(scene.creatureSpawner.enabled, false);
  scene.addPlayer({ id: 'p1', name: '路人', slot: 0 });
  runTicks(scene, clock, 200);
  assert.equal(scene.creatureSpawner.liveCount, 0);
  assert.equal(spawnedActors(scene).length, 0);
});

test('nightOnly 在没有昼夜时钟的图上一只都不刷，而不是整天刷', async () => {
  // 「只在夜里刷」在一张停在正午的地图上永远不成立。反过来（永远成立）看起来
  // 像是配置没生效，作者会盯着满地的怪找一个不存在的 bug。
  const { scene, clock } = await createScene((definition) => {
    definition.gameplay.creatureSpawns[0].nightOnly = true;
    definition.environment = { ...definition.environment, dayNight: { enabled: false } };
    return definition;
  });
  assert.equal(scene.environment.dayNightEnabled, false, '这张图的昼夜时钟是关着的');
  scene.addPlayer({ id: 'p1', name: '路人', slot: 0 });
  placePlayer(scene.players.get('p1'), 0, 0);
  runTicks(scene, clock, 1200);
  assert.equal(scene.creatureSpawner.liveCount, 0);
});

test('开了昼夜之后 nightOnly 只在夜里出怪，白天一只不刷', async () => {
  const nightScene = await createScene((definition) => {
    definition.gameplay.creatureSpawns[0].nightOnly = true;
    definition.environment = {
      ...definition.environment,
      dayNight: { enabled: true, startHour: 22, dayLengthSeconds: 86_400 },
    };
    return definition;
  });
  nightScene.scene.addPlayer({ id: 'p1', name: '夜行者', slot: 0 });
  placePlayer(nightScene.scene.players.get('p1'), 0, 0);
  runTicks(nightScene.scene, nightScene.clock, 1200);
  assert.ok(nightScene.scene.creatureSpawner.liveCount > 0, '夜里该出怪');

  const dayScene = await createScene((definition) => {
    definition.gameplay.creatureSpawns[0].nightOnly = true;
    definition.environment = {
      ...definition.environment,
      // 一天走一整天的真实秒数，测试跑完仍然停在正午前后。
      dayNight: { enabled: true, startHour: 12, dayLengthSeconds: 86_400 },
    };
    return definition;
  });
  dayScene.scene.addPlayer({ id: 'p1', name: '白日行者', slot: 0 });
  placePlayer(dayScene.scene.players.get('p1'), 0, 0);
  runTicks(dayScene.scene, dayScene.clock, 1200);
  assert.equal(dayScene.scene.creatureSpawner.liveCount, 0, '白天不该出怪');
});
