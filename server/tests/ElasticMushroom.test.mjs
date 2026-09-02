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

test('拔出来之前只是长在地上的东西：叼住拖拽都不产生刚体，也不下发朝向', async () => {
  const clock = createClock();
  const catalog = await SceneCatalog.load();
  const scene = new ServerScene(catalog.require('grassland'), { now: clock.now });
  scene.addPlayer({ id: 'player-c', name: '还没拔断', slot: 0 });

  const mushroomId = 'elastic-mushroom-01';
  const initial = scene.createSnapshot().actors.find((actor) => actor.id === mushroomId);
  const player = scene.players.get('player-c');
  player.x = initial.transform.x - 0.8;
  player.z = initial.transform.z;
  assert.equal(scene.interactWithActor('player-c', { actorId: mushroomId, sequence: 1 }), true);

  // 在断裂长度以内反复拖拽：这一整段里它都还长在地上。
  for (const distance of [0.8, 1.0, 1.2, 0.9]) {
    player.x = initial.transform.x - distance;
    clock.advance(0.05);
    scene.update();

    const held = scene.createSnapshot().actors.find((actor) => actor.id === mushroomId);
    assert.equal(held.elasticDetach.detached, false, `拖到 ${distance}m 就断了`);
    assert.equal(held.elasticDetach.rotation, undefined, '没拔断却下发了刚体朝向');
    assert.equal(
      scene.physics.hasDynamicActor(mushroomId),
      false,
      '没拔断却已经建了动态刚体',
    );
    assert.equal(held.elasticTether.holderPlayerId, 'player-c');
    // 长在地上的东西不会自己动：位置始终是原来那一个。
    assert.equal(held.transform.x, initial.transform.x);
    assert.equal(held.transform.y, initial.transform.y);
    assert.equal(held.transform.z, initial.transform.z);
  }
});

test('拖拽行程从叼住那一刻起算，站多远按 E 都一样长', async () => {
  const catalog = await SceneCatalog.load();
  const mushroomId = 'elastic-mushroom-01';

  /** 从指定距离叼住，返回还能后退多远才拔断。 */
  const dragRange = (grabDistance) => {
    const clock = createClock();
    const scene = new ServerScene(catalog.require('grassland'), { now: clock.now });
    scene.addPlayer({ id: 'puller', name: '拖拽者', slot: 0 });
    const initial = scene.createSnapshot().actors.find((actor) => actor.id === mushroomId);
    const player = scene.players.get('puller');
    player.x = initial.transform.x - grabDistance;
    player.z = initial.transform.z;
    player.yaw = Math.PI / 2;
    assert.equal(scene.interactWithActor('puller', { actorId: mushroomId, sequence: 1 }), true);
    const snap = () => scene.createSnapshot().actors.find((actor) => actor.id === mushroomId);
    for (let extra = 0; extra <= 4; extra += 0.02) {
      player.x = initial.transform.x - grabDistance - extra;
      clock.advance(0.02);
      scene.update();
      if (snap().elasticDetach.detached) return extra;
    }
    return undefined;
  };

  // 贴脸按和顶着交互距离按，拖拽行程必须接近；绝对 breakLength 判定下这两个
  // 数字会差出两倍多，玩起来就是「走近按一下能拖、站远按一下直接掉」。
  const close = dragRange(0.5);
  const far = dragRange(1.35);
  assert.ok(close !== undefined && far !== undefined, '一直没拔断');
  assert.ok(far > 1.2, `站远按 E 只能拖 ${far?.toFixed(2)}m，几乎没有拖拽过程`);
  assert.ok(
    Math.abs(close - far) < 0.3,
    `拖拽行程受起手距离影响太大：${close?.toFixed(2)}m vs ${far?.toFixed(2)}m`,
  );
});

test('走远让 chunk 卸载再回来，躺在地上的蘑菇不会站起来', async () => {
  const clock = createClock();
  const catalog = await SceneCatalog.load();
  const scene = new ServerScene(catalog.require('open-world'), { now: clock.now });
  scene.addPlayer({ id: 'wanderer', name: '路过的人', slot: 0 });
  const player = scene.players.get('wanderer');
  const tick = (times) => {
    for (let index = 0; index < times; index += 1) {
      clock.advance(0.05);
      scene.update();
    }
  };
  tick(5);

  const target = scene.createSnapshot().actors
    .find((actor) => actor.archetypeId === 'elastic-mushroom');
  assert.ok(target, '这一片没有生成蘑菇');
  const find = () => scene.createSnapshot().actors.find((actor) => actor.id === target.id);

  /** 菌柄的向上轴离竖直有多远：立着 ≈ 0°，躺倒 ≈ 90°。 */
  const tiltDegrees = (rotation) => {
    if (!Array.isArray(rotation)) return undefined;
    const [x, , z] = rotation;
    return Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (x * x + z * z)))) * 180 / Math.PI;
  };

  player.x = target.transform.x - 1;
  player.z = target.transform.z;
  player.yaw = Math.PI / 2;
  tick(1);
  assert.equal(scene.interactWithActor('wanderer', { actorId: target.id, sequence: 1 }), true);
  player.x = target.transform.x - 3.4;
  tick(60);

  const fallenTilt = tiltDegrees(find().elasticDetach.rotation);
  assert.ok(fallenTilt > 60, `蘑菇没有躺下：${fallenTilt?.toFixed(1)}°`);

  // 走出 keep 半径让 chunk 卸载，再走回来。
  player.x = target.transform.x + 300;
  player.z = target.transform.z + 300;
  tick(40);
  assert.equal(scene.actorWorld.getActor(target.id), undefined, 'chunk 没有卸载，用例没测到重建');

  player.x = target.transform.x - 2;
  player.z = target.transform.z;
  tick(40);

  const restored = find();
  assert.ok(restored, '走回来蘑菇不见了');
  assert.equal(restored.elasticDetach.detached, true);
  const restoredTilt = tiltDegrees(restored.elasticDetach.rotation);
  assert.ok(
    restoredTilt > 60,
    `重建之后蘑菇站起来了：${restoredTilt?.toFixed(1)}°（躺下时是 ${fallenTilt.toFixed(1)}°）`,
  );
});
