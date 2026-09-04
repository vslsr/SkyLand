import assert from 'node:assert/strict';
import test from 'node:test';
import './initRapier.mjs';
import {
  DEAD_STATE_TAG,
  GAME_ABILITY_COMPONENT,
  HEALTH_ATTRIBUTE,
} from '../../shared/abilities/index.mjs';
import { HEALTH_COMPONENT, TRANSFORM_COMPONENT } from '../../shared/actor/index.mjs';
import { applyDamage, applyHeal } from '../actors/HealthMutations.mjs';
import { SceneCatalog } from '../scenes/SceneCatalog.mjs';
import { ServerScene } from '../scene/ServerScene.mjs';

const catalogPromise = SceneCatalog.load();

async function createScene(sceneId = 'pbf-slime-test') {
  const catalog = await catalogPromise;
  let now = 1_000_000;
  const scene = new ServerScene(catalog.require(sceneId), { now: () => now });
  return {
    scene,
    get now() { return now; },
    advance(seconds) { now += seconds * 1000; },
  };
}

function healthOf(actor) {
  return actor.requireComponent(HEALTH_COMPONENT);
}

test('带 health 的 Actor 出生就有 GAS 生命值属性，并且进快照', async () => {
  const { scene } = await createScene();
  const walker = scene.actorWorld.getActor('legged-slime-walker-near');
  assert.ok(walker, '场景里应当有这只巡逻史莱姆');

  const health = healthOf(walker);
  assert.equal(health.maximum, 100);
  assert.equal(health.current, 100);
  assert.equal(health.dead, false);
  // 权威数值住在 GAS 属性里，Component 只是它的复制面。
  const abilitySystem = walker.requireComponent(GAME_ABILITY_COMPONENT).abilitySystem;
  assert.equal(abilitySystem.attributes.getCurrentValue(HEALTH_ATTRIBUTE), 100);

  const replicated = scene.createSnapshot().actors
    .find((actor) => actor.id === 'legged-slime-walker-near');
  assert.deepEqual(replicated.health, {
    current: 100,
    maximum: 100,
    dead: false,
    deathRevision: 0,
    lastDelta: 0,
    eventRevision: 0,
    revision: 0,
  });
});

test('伤害走 GAS Instant Effect：血掉了，复制面同步，事件计数自增', async () => {
  const { scene } = await createScene();
  const walker = scene.actorWorld.getActor('legged-slime-walker-near');
  const health = healthOf(walker);

  const change = applyDamage(walker, 30, { nowSeconds: 100 });
  assert.equal(change.delta, -30);
  assert.equal(change.after, 70);
  assert.equal(change.died, false);
  assert.equal(health.current, 70);
  assert.equal(health.lastDelta, -30);
  assert.equal(health.eventRevision, 1);
  assert.equal(health.revision, 1);
  assert.equal(
    walker.requireComponent(GAME_ABILITY_COMPONENT).abilitySystem
      .attributes.getCurrentValue(HEALTH_ATTRIBUTE),
    70,
  );

  // 治疗溢出的那一部分被属性上限吃掉，不会治到 100 以上。
  const healed = applyHeal(walker, 999, { nowSeconds: 101 });
  assert.equal(healed.after, 100);
  assert.equal(healed.delta, 30);
  assert.equal(health.eventRevision, 2);

  // 满血再治一次什么都没发生：调用方不必自己判断空操作。
  assert.equal(applyHeal(walker, 10, { nowSeconds: 102 }), undefined);
  assert.equal(health.eventRevision, 2);
});

test('血到 0 就死：挂 State.Dead，死亡计数自增，尸体不再掉血也治不回来', async () => {
  const { scene } = await createScene();
  const walker = scene.actorWorld.getActor('legged-slime-walker-near');
  const health = healthOf(walker);
  const abilitySystem = walker.requireComponent(GAME_ABILITY_COMPONENT).abilitySystem;

  const killed = applyDamage(walker, 250, { nowSeconds: 500 });
  assert.equal(killed.died, true);
  assert.equal(killed.after, 0);
  assert.equal(health.dead, true);
  assert.equal(health.deathRevision, 1);
  assert.equal(health.diedAt, 500);
  assert.ok(abilitySystem.hasTag(DEAD_STATE_TAG), '死亡状态挂在 GAS 标签上');

  const eventRevision = health.eventRevision;
  assert.equal(applyDamage(walker, 10, { nowSeconds: 501 }), undefined, '尸体不再掉血');
  assert.equal(applyHeal(walker, 50, { nowSeconds: 502 }), undefined, '尸体也治不回来');
  assert.equal(health.eventRevision, eventRevision, '空操作不该产生飘字');
  assert.equal(health.deathRevision, 1, '死亡计数只走一次');
});

test('死了就不走了，尸体到点从世界里消失', async () => {
  const context = await createScene();
  const { scene } = context;
  const walker = scene.actorWorld.getActor('legged-slime-walker-near');
  const transform = walker.requireComponent(TRANSFORM_COMPONENT);

  context.advance(1);
  scene.update();
  const movedZ = transform.z;
  assert.notEqual(movedZ, 0, '活着的时候它在走');

  scene.applyHealthChange(walker.id, -100);
  context.advance(1);
  scene.update();
  assert.equal(transform.z, movedZ, '死了之后停在倒下的那一格');
  assert.ok(scene.actorWorld.getActor(walker.id), '尸体先留在世界里给人看');

  // corpseSeconds 是 8，跨过去之后这一具尸体才被收走。
  context.advance(9);
  scene.update();
  assert.equal(scene.actorWorld.getActor(walker.id), undefined, '尸体到点销毁');
  assert.equal(
    scene.createSnapshot().actors.find((actor) => actor.id === walker.id),
    undefined,
  );
});

test('玩家死亡：血量随玩家快照下发，输入不再驱动他，交互与建造一律不受理', async () => {
  const context = await createScene();
  const { scene } = context;
  scene.addPlayer({ id: 'victim', name: '倒霉蛋', slot: 0 });
  const player = scene.players.get('victim');
  assert.equal(player.health.maximum, 100);
  assert.equal(player.dead, false);

  const alive = scene.createSnapshot('victim').players.find((entry) => entry.id === 'victim');
  assert.equal(alive.health.current, 100);
  assert.equal(alive.health.dead, false);

  const died = scene.applyHealthChange('victim', -100);
  assert.equal(died.died, true);
  assert.equal(player.dead, true);

  const startX = player.x;
  const startZ = player.z;
  scene.applyInput('victim', {
    inputs: [{ tick: 1, move: { x: 1, z: 1 }, sprint: true, yaw: 0.5 }],
  });
  assert.equal(player.ackTick, 1, '输入仍要被确认，否则客户端会一直重发');
  assert.ok(Math.abs(player.x - startX) < 1e-6, '死了之后自己不再移动');
  assert.ok(Math.abs(player.z - startZ) < 1e-6);

  assert.equal(scene.applyBuildCommand('victim', { sequence: 1, command: { kind: 'place' } }), false);
  assert.equal(scene.applyInventoryCommand('victim', { sequence: 1, command: { kind: 'cycle' } }), false);
  assert.equal(scene.interactWithActor('victim', { sequence: 1, actorId: 'pbf-collision-dummy-center' }), false);
  assert.equal(scene.toggleBite('victim'), false);

  const dead = scene.createSnapshot('victim').players.find((entry) => entry.id === 'victim');
  assert.equal(dead.health.dead, true);
  assert.equal(dead.health.deathRevision, 1);
  assert.equal(dead.health.lastDelta, -100);
});

test('调试伤害指令只够得到身边的生物或自己，够不到的时候什么都不发生', async () => {
  const context = await createScene();
  const { scene } = context;
  scene.addPlayer({ id: 'tester', name: '测试员', slot: 0 });
  const player = scene.players.get('tester');
  const walker = scene.actorWorld.getActor('legged-slime-walker-near');
  const walkerTransform = walker.requireComponent(TRANSFORM_COMPONENT);

  // 站得远：够不到任何生物。
  player.setPosition(walkerTransform.x + 20, walkerTransform.z + 20);
  assert.equal(scene.applyHealthDebugCommand('tester', { amount: -10 }), undefined);
  assert.equal(healthOf(walker).current, 100);

  // 走到跟前：打的是最近那一只。
  player.setPosition(walkerTransform.x + 1, walkerTransform.z);
  const hit = scene.applyHealthDebugCommand('tester', { amount: -25 });
  assert.equal(hit.actorId, walker.id);
  assert.equal(healthOf(walker).current, 75);

  // 打自己走另一条分支，和距离无关。
  const selfHit = scene.applyHealthDebugCommand('tester', { target: 'self', amount: -40 });
  assert.equal(selfHit.actorId, 'tester');
  assert.equal(player.health.current, 60);

  // 治疗用正数，和飘字读到的 lastDelta 同号。
  const healed = scene.applyHealthDebugCommand('tester', { target: 'self', amount: 15 });
  assert.equal(healed.delta, 15);
  assert.equal(player.health.lastDelta, 15);
});
