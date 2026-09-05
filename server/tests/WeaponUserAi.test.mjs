import assert from 'node:assert/strict';
import test from 'node:test';
import './initRapier.mjs';
import {
  HEALTH_COMPONENT,
  PROJECTILE_COMPONENT,
  TRANSFORM_COMPONENT,
  WEAPON_SHOT_COMPONENT,
  WEAPON_USER_COMPONENT,
} from '../../shared/actor/index.mjs';
import { SceneCatalog } from '../scenes/SceneCatalog.mjs';
import { ServerScene } from '../scene/ServerScene.mjs';

/**
 * 会用弓的 AI 单位。
 *
 * 这一份测的是那道新缝：开火不再要求射手是玩家。同一个 `fireWeaponFrom` 同时
 * 兑现玩家扣扳机和 AI 拉满了放手——判定、伤害、复制因此只有一条路径。
 */

const catalogPromise = SceneCatalog.load();

async function createScene() {
  const catalog = await catalogPromise;
  let now = 3_000_000;
  const scene = new ServerScene(catalog.require('grassland'), { now: () => now });
  return {
    scene,
    advance(seconds) {
      now += seconds * 1000;
      scene.update();
    },
  };
}

/** 把弓手挪到玩家正前方一段距离上，好让它一定能瞄到人。 */
function placeArcher(scene, playerX, playerZ, distance) {
  const archer = scene.actorWorld.getActor('legged-slime-archer-01');
  const transform = archer.requireComponent(TRANSFORM_COMPONENT);
  // 背对着放：转过身来那一段正是它的破绽，测试也该经过它。
  transform.setWorldTransform([playerX, transform.y, playerZ + distance], 0);
  return archer;
}

test('弓手转向玩家、拉满了才放，放出去的是同一条判定', async () => {
  const context = await createScene();
  const { scene } = context;
  scene.addPlayer({ id: 'target', name: '靶子', slot: 0 });
  const player = scene.players.get('target');
  player.setPosition(0, 0);
  const health = player.requireComponent(HEALTH_COMPONENT);
  // 弓拉满射 22 米，站近一点，让落点稳稳落在玩家身上。
  const archer = placeArcher(scene, 0, 0, 8);
  const user = archer.requireComponent(WEAPON_USER_COMPONENT);
  const transform = archer.requireComponent(TRANSFORM_COMPONENT);

  // 第一帧先转身：还没瞄上就不该攒力，否则它会朝着侧面放出一箭。
  context.advance(0.1);
  assert.ok(Math.abs(transform.yaw) > 0.1, '正在转过来（朝向玩家是 yaw ≈ π）');
  assert.equal(user.chargedSeconds, 0, '没瞄上就不攒力');

  // 给足转身与拉弓的时间。
  for (let step = 0; step < 40; step += 1) context.advance(0.1);
  assert.ok(Math.abs(Math.abs(transform.yaw) - Math.PI) < 0.2, '面朝玩家');
  assert.ok(health.current < health.maximum, '挨了箭');

  // 伤害走的是同一份武器数据：木弓基础 5，蓄力倍率最多 2 倍。
  assert.ok(health.maximum - health.current <= 10 + 1e-6);
  // 蓄力比例由距离反解，所以八米外的那一发不会是拉满的十成。这个数现在记在飞出去
  // 那支箭身上（快照里那条只剩一个计数），所以问它。
  const arrows = scene.actorWorld.query(PROJECTILE_COMPONENT);
  assert.ok(arrows.length > 0, '天上或地上该留着刚射出去的那支箭');
  assert.ok(arrows[0].requireComponent(PROJECTILE_COMPONENT).ratio < 1);
  assert.equal(arrows[0].requireComponent(PROJECTILE_COMPONENT).ownerActorId, archer.id);
  // 射出去那一发记在弓手自己身上，不是记在某个玩家的裸属性上。
  assert.ok(archer.requireComponent(WEAPON_SHOT_COMPONENT).revision > 0);
});

test('弓手那一发也进快照：客户端不需要知道射手是不是玩家', async () => {
  const context = await createScene();
  const { scene } = context;
  scene.addPlayer({ id: 'target', name: '靶子', slot: 0 });
  scene.players.get('target').setPosition(0, 0);
  placeArcher(scene, 0, 0, 8);

  const archerSnapshot = () => scene.createSnapshot('target')
    .actors.find((entry) => entry.id === 'legged-slime-archer-01');
  // 一发都没射过时整条不下发。
  assert.equal(archerSnapshot().weaponShot, undefined);

  for (let step = 0; step < 40; step += 1) context.advance(0.1);
  const shot = archerSnapshot().weaponShot;
  assert.equal(shot.revision >= 1, true);
  // 和玩家那条是同一个形状：只有一个计数。飞出去那支箭是复制过来的 Actor，
  // 落在哪儿由它自己说了算，接收方拿这条抖一下弦而已。
  assert.deepEqual(Object.keys(shot).sort(), ['revision']);
});

test('目标走出射程就把弓放下，拉到一半的那一段不留着', async () => {
  const context = await createScene();
  const { scene } = context;
  scene.addPlayer({ id: 'target', name: '靶子', slot: 0 });
  const player = scene.players.get('target');
  player.setPosition(0, 0);
  const archer = placeArcher(scene, 0, 0, 8);
  const user = archer.requireComponent(WEAPON_USER_COMPONENT);

  // 先给足转身的时间（背对着放的，转过来要一秒多），再看它有没有在攒力。
  for (let step = 0; step < 40; step += 1) context.advance(0.05);
  assert.ok(user.chargedSeconds > 0, '正在拉');

  // 跑到交战半径之外。
  player.setPosition(0, 400);
  context.advance(0.05);
  assert.equal(user.chargedSeconds, 0, '放下弓，下次要重新拉');
});

test('死了的弓手不放箭', async () => {
  const context = await createScene();
  const { scene } = context;
  scene.addPlayer({ id: 'target', name: '靶子', slot: 0 });
  scene.players.get('target').setPosition(0, 0);
  const archer = placeArcher(scene, 0, 0, 8);
  scene.applyHealthChange(archer.id, -999);
  assert.equal(archer.requireComponent(HEALTH_COMPONENT).dead, true);

  for (let step = 0; step < 40; step += 1) context.advance(0.1);
  assert.equal(archer.requireComponent(WEAPON_SHOT_COMPONENT).revision, 0);
});
