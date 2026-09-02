import assert from 'node:assert/strict';
import test from 'node:test';
import { ServerScene } from '../scene/ServerScene.mjs';
import { SceneCatalog } from '../scenes/SceneCatalog.mjs';
import {
  ElasticDetachComponent,
  MushroomPopComponent,
} from '../../shared/actor/index.mjs';

function createClock(startAt = 1_000_000) {
  let current = startAt;
  return {
    now: () => current,
    advance(seconds) { current += seconds * 1000; },
  };
}

test('史莱姆把蘑菇拉过断裂长度后，蘑菇脱离、获得冲量并落回地面', async () => {
  const clock = createClock();
  const catalog = await SceneCatalog.load();
  const scene = new ServerScene(catalog.require('grassland'), { now: clock.now });
  scene.addPlayer({ id: 'player-a', name: '蘑菇测试员', slot: 0 });

  const mushroomId = 'elastic-mushroom-01';
  const initial = scene.createSnapshot().actors.find((actor) => actor.id === mushroomId);
  assert.ok(initial);
  assert.equal(initial.interactable.action, 'mushroom-bite');
  assert.equal(initial.elasticTether.holderPlayerId, null);

  const player = scene.players.get('player-a');
  player.x = initial.transform.x - 0.8;
  player.z = initial.transform.z;
  player.yaw = Math.PI / 2;
  assert.equal(scene.interactWithActor('player-a', {
    actorId: mushroomId,
    sequence: 1,
  }), true);

  let mushroom = scene.createSnapshot().actors.find((actor) => actor.id === mushroomId);
  assert.equal(mushroom.elasticTether.holderPlayerId, 'player-a');
  assert.equal(mushroom.interactable.enabled, false);
  assert.ok(Number.isFinite(mushroom.elasticTether.targetX));
  assert.equal(scene.interactWithActor('player-a', {
    actorId: mushroomId,
    sequence: 2,
  }), false);

  player.x = initial.transform.x - 3.4;
  player.z = initial.transform.z;
  clock.advance(0.05);
  scene.update();
  mushroom = scene.createSnapshot().actors.find((actor) => actor.id === mushroomId);
  assert.equal(mushroom.elasticTether.holderPlayerId, null);
  assert.equal(mushroom.elasticTether.releaseRevision, 1);
  assert.equal(mushroom.elasticDetach.detached, true);
  assert.equal(mushroom.interactable.enabled, false);
  assert.ok(mushroom.transform.y > initial.transform.y);

  player.x = initial.transform.x - 0.7;
  assert.equal(scene.interactWithActor('player-a', {
    actorId: mushroomId,
    sequence: 3,
  }), false);
  for (let index = 0; index < 100; index += 1) {
    clock.advance(0.05);
    scene.update();
  }
  mushroom = scene.createSnapshot().actors.find((actor) => actor.id === mushroomId);
  assert.ok(Math.abs(mushroom.transform.y) < 1e-4);
  scene.removePlayer('player-a');
  mushroom = scene.createSnapshot().actors.find((actor) => actor.id === mushroomId);
  assert.equal(mushroom.elasticTether.holderPlayerId, null);
  assert.equal(mushroom.elasticTether.releaseRevision, 1);
  assert.equal(mushroom.interactable.enabled, false);
});
import './initRapier.mjs';

test('蘑菇脱落后翻倒在地，权威朝向随快照下发', async () => {
  const clock = createClock();
  const catalog = await SceneCatalog.load();
  const scene = new ServerScene(catalog.require('grassland'), { now: clock.now });
  scene.addPlayer({ id: 'player-b', name: '拔蘑菇的人', slot: 0 });

  const mushroomId = 'elastic-mushroom-01';
  const initial = scene.createSnapshot().actors.find((actor) => actor.id === mushroomId);
  // 还长在地上时不该占用带宽发姿态：yaw 已经描述完摆放。
  assert.equal(initial.elasticDetach.rotation, undefined);

  const player = scene.players.get('player-b');
  player.x = initial.transform.x - 0.8;
  player.z = initial.transform.z;
  scene.interactWithActor('player-b', { actorId: mushroomId, sequence: 1 });
  player.x = initial.transform.x - 3.4;
  clock.advance(0.05);
  scene.update();

  for (let index = 0; index < 100; index += 1) {
    clock.advance(0.05);
    scene.update();
  }

  const settled = scene.createSnapshot().actors.find((actor) => actor.id === mushroomId);
  assert.equal(settled.elasticDetach.detached, true);
  const rotation = settled.elasticDetach.rotation;
  assert.ok(Array.isArray(rotation) && rotation.length === 4, '脱落后没有下发朝向');
  const length = Math.hypot(...rotation);
  assert.ok(Math.abs(length - 1) < 0.01, `朝向不是单位四元数：${length}`);

  // 把菌柄的向上轴旋过去，看它离竖直有多远：立着 ≈ 0°，躺倒 ≈ 90°。
  const [x, y, z, w] = rotation;
  const upY = 1 - 2 * (x * x + z * z);
  const tiltDegrees = Math.acos(Math.max(-1, Math.min(1, upY))) * 180 / Math.PI;
  assert.ok(tiltDegrees > 60, `蘑菇仍然立着，倾角只有 ${tiltDegrees.toFixed(1)}°`);
});

test('没有配置翻滚冲量时蘑菇只弹出、不翻滚', () => {
  const detachable = new ElasticDetachComponent({});
  new MushroomPopComponent({ forwardImpulse: 0.5, upwardImpulse: 2 }).bind(detachable);
  const popped = detachable.pop({ x: 1, y: 0, z: 0 });
  assert.ok(popped.impulse.y > 0);
  assert.deepEqual(popped.torqueImpulse, { x: 0, y: 0, z: 0 });
});

test('翻滚冲量绕着垂直于弹出方向的水平轴施加', () => {
  const detachable = new ElasticDetachComponent({});
  new MushroomPopComponent({
    forwardImpulse: 0,
    upwardImpulse: 0,
    spinImpulse: 0.08,
  }).bind(detachable);
  // 朝 +X 弹出：翻滚轴应当是 -Z，菌盖才会朝弹出方向翻过去。
  const popped = detachable.pop({ x: 1, y: 0, z: 0 });
  assert.ok(Math.abs(popped.torqueImpulse.x) < 1e-9);
  assert.equal(popped.torqueImpulse.y, 0);
  assert.ok(Math.abs(popped.torqueImpulse.z + 0.08) < 1e-9, JSON.stringify(popped.torqueImpulse));
});
