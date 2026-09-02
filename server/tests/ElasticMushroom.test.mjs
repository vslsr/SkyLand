import assert from 'node:assert/strict';
import test from 'node:test';
import { ServerScene } from '../scene/ServerScene.mjs';
import { SceneCatalog } from '../scenes/SceneCatalog.mjs';

/**
 * 把玩家拖到「一定拉得断」的距离。
 *
 * 拔断阈值是「叼住那一刻的长度 + pullDistance」，所以写死一个米数会随配置调整
 * 失效；这里直接读权威的 detachLength 再多留一点余量。
 */
function pullUntilDetached(scene, clock, playerId, actorId, anchorX) {
  const player = scene.players.get(playerId);
  const tether = scene.actorWorld.getActor(actorId).requireComponent('elastic-tether');
  player.x = anchorX - (tether.detachLength + 1);
  for (let index = 0; index < 20; index += 1) {
    clock.advance(0.05);
    scene.update();
    if (scene.actorWorld.getActor(actorId).requireComponent('elasticDetach').detached) return true;
  }
  return false;
}

function createClock(startAt = 1_000_000) {
  let current = startAt;
  return {
    now: () => current,
    advance(seconds) { current += seconds * 1000; },
  };
}

test('叼住 → 拖拽 → 拔断进嘴 → 放下落地：一整趟交互', async () => {
  const clock = createClock();
  const catalog = await SceneCatalog.load();
  const scene = new ServerScene(catalog.require('grassland'), { now: clock.now });
  scene.addPlayer({ id: 'player-a', name: '蘑菇测试员', slot: 0 });

  const mushroomId = 'elastic-mushroom-01';
  const initial = scene.createSnapshot().actors.find((actor) => actor.id === mushroomId);
  assert.ok(initial);
  assert.equal(initial.interactable.action, 'mushroom-bite');
  assert.equal(initial.elasticTether.holderPlayerId, null);
  const find = () => scene.createSnapshot().actors.find((actor) => actor.id === mushroomId);

  const player = scene.players.get('player-a');
  player.x = initial.transform.x - 0.8;
  player.z = initial.transform.z;
  player.yaw = Math.PI / 2;
  assert.equal(scene.interactWithActor('player-a', { actorId: mushroomId, sequence: 1 }), true);

  let mushroom = find();
  assert.equal(mushroom.elasticTether.holderPlayerId, 'player-a');
  assert.equal(mushroom.interactable.enabled, false);
  assert.ok(Number.isFinite(mushroom.elasticTether.targetX));

  assert.equal(
    pullUntilDetached(scene, clock, 'player-a', mushroomId, initial.transform.x),
    true,
  );
  mushroom = find();
  assert.equal(mushroom.elasticTether.holderPlayerId, null);
  assert.equal(mushroom.elasticTether.releaseRevision, 1);
  assert.equal(mushroom.elasticDetach.detached, true);
  // 拔断之后它在嘴上，不是掉在地上：既没有落回地面，也还不是自由刚体。
  assert.equal(mushroom.elasticDetach.carriedByPlayerId, 'player-a');
  assert.equal(scene.physics.hasDynamicActor(mushroomId), false);
  assert.ok(mushroom.transform.y > initial.transform.y);

  // 叼着走，蘑菇跟着嘴动。
  player.x = initial.transform.x + 6;
  player.z = initial.transform.z + 4;
  player.yaw = 0;
  clock.advance(0.05);
  scene.update();
  mushroom = find();
  assert.ok(
    Math.hypot(mushroom.transform.x - player.x, mushroom.transform.z - player.z) < 1,
    '叼着的蘑菇没有跟着玩家走',
  );

  // 再按一次交互键放下：不给冲量，就在离手的位置落下。
  assert.equal(scene.interactWithActor('player-a', { actorId: mushroomId, sequence: 2 }), true);
  const dropX = find().transform.x;
  const dropZ = find().transform.z;
  assert.equal(find().elasticDetach.carriedByPlayerId, null);
  assert.equal(scene.physics.hasDynamicActor(mushroomId), true);

  for (let index = 0; index < 100; index += 1) {
    clock.advance(0.05);
    scene.update();
  }
  mushroom = find();
  assert.ok(Math.abs(mushroom.transform.y) < 1e-3, `没有落到地面：${mushroom.transform.y}`);
  // 不弹：落点应当就在离手的位置附近，不会被冲量抛出去。
  assert.ok(
    Math.hypot(mushroom.transform.x - dropX, mushroom.transform.z - dropZ) < 0.35,
    '放下时被抛出去了',
  );

  scene.removePlayer('player-a');
  mushroom = find();
  assert.equal(mushroom.elasticTether.holderPlayerId, null);
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
  assert.equal(
    pullUntilDetached(scene, clock, 'player-b', mushroomId, initial.transform.x),
    true,
  );

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
  assert.equal(
    pullUntilDetached(scene, clock, 'wanderer', target.id, target.transform.x),
    true,
  );
  tick(60);

  // 放下它，让它成为躺在地上的自由刚体——这条用例问的是「地上那株」的姿态
  // 能不能扛过 chunk 卸载。
  assert.equal(scene.interactWithActor('wanderer', { actorId: target.id, sequence: 2 }), true);
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

test('还没拔断时再按一次交互键，取消拖拽并恢复可交互', async () => {
  const clock = createClock();
  const catalog = await SceneCatalog.load();
  const scene = new ServerScene(catalog.require('grassland'), { now: clock.now });
  scene.addPlayer({ id: 'player-d', name: '半路松口', slot: 0 });

  const mushroomId = 'elastic-mushroom-01';
  const initial = scene.createSnapshot().actors.find((actor) => actor.id === mushroomId);
  const find = () => scene.createSnapshot().actors.find((actor) => actor.id === mushroomId);
  const player = scene.players.get('player-d');
  player.x = initial.transform.x - 0.8;
  player.z = initial.transform.z;
  player.yaw = Math.PI / 2;

  assert.equal(scene.interactWithActor('player-d', { actorId: mushroomId, sequence: 1 }), true);
  // 拖一段但不拉断。
  player.x = initial.transform.x - 1.6;
  clock.advance(0.05);
  scene.update();
  assert.equal(find().elasticDetach.detached, false);

  assert.equal(scene.interactWithActor('player-d', { actorId: mushroomId, sequence: 2 }), true);
  const cancelled = find();
  assert.equal(cancelled.elasticTether.holderPlayerId, null);
  assert.equal(cancelled.elasticDetach.detached, false);
  assert.equal(cancelled.elasticDetach.carriedByPlayerId, null);
  // 松开之后它还长在原地，而且可以重新叼。
  assert.equal(cancelled.interactable.enabled, true);
  assert.equal(cancelled.transform.x, initial.transform.x);
  assert.equal(cancelled.transform.z, initial.transform.z);
  player.x = initial.transform.x - 0.8;
  assert.equal(scene.interactWithActor('player-d', { actorId: mushroomId, sequence: 3 }), true);
});

test('嘴里已经叼着一株时，不能再叼另一株', async () => {
  const clock = createClock();
  const catalog = await SceneCatalog.load();
  const scene = new ServerScene(catalog.require('open-world'), { now: clock.now });
  scene.addPlayer({ id: 'greedy', name: '贪心', slot: 0 });
  const player = scene.players.get('greedy');
  const tick = (times) => {
    for (let index = 0; index < times; index += 1) {
      clock.advance(0.05);
      scene.update();
    }
  };
  tick(5);

  const [first, second] = scene.createSnapshot().actors
    .filter((actor) => actor.archetypeId === 'elastic-mushroom');
  assert.ok(first && second, '这一片没有生成两株蘑菇');

  player.x = first.transform.x - 0.8;
  player.z = first.transform.z;
  player.yaw = Math.PI / 2;
  tick(1);
  assert.equal(scene.interactWithActor('greedy', { actorId: first.id, sequence: 1 }), true);
  assert.equal(
    pullUntilDetached(scene, clock, 'greedy', first.id, first.transform.x),
    true,
  );
  assert.equal(scene.findCarriedActorId('greedy'), first.id);

  player.x = second.transform.x - 0.8;
  player.z = second.transform.z;
  tick(1);
  assert.equal(
    scene.interactWithActor('greedy', { actorId: second.id, sequence: 2 }),
    false,
    '嘴里有东西还能再叼',
  );

  // 放下手上这株之后才能叼下一株。
  assert.equal(scene.interactWithActor('greedy', { actorId: first.id, sequence: 3 }), true);
  tick(1);
  assert.equal(scene.interactWithActor('greedy', { actorId: second.id, sequence: 4 }), true);
});

test('玩家离开房间时，叼着的那株原地落下而不是跟着消失', async () => {
  const clock = createClock();
  const catalog = await SceneCatalog.load();
  const scene = new ServerScene(catalog.require('grassland'), { now: clock.now });
  scene.addPlayer({ id: 'leaver', name: '要走了', slot: 0 });

  const mushroomId = 'elastic-mushroom-01';
  const initial = scene.createSnapshot().actors.find((actor) => actor.id === mushroomId);
  const player = scene.players.get('leaver');
  player.x = initial.transform.x - 0.8;
  player.z = initial.transform.z;
  player.yaw = Math.PI / 2;
  scene.interactWithActor('leaver', { actorId: mushroomId, sequence: 1 });
  assert.equal(
    pullUntilDetached(scene, clock, 'leaver', mushroomId, initial.transform.x),
    true,
  );
  assert.equal(scene.findCarriedActorId('leaver'), mushroomId);

  scene.removePlayer('leaver');
  const left = scene.createSnapshot().actors.find((actor) => actor.id === mushroomId);
  assert.ok(left, '玩家离开把蘑菇一起带走了');
  assert.equal(left.elasticDetach.carriedByPlayerId, null);
  assert.equal(scene.physics.hasDynamicActor(mushroomId), true, '没有变回自由刚体');
});

test('放进水里的物件停在水底，不会一直往下掉', async () => {
  const clock = createClock();
  const catalog = await SceneCatalog.load();
  const scene = new ServerScene(catalog.require('open-world'), { now: clock.now });
  scene.addPlayer({ id: 'diver', name: '丢水里', slot: 0 });
  const player = scene.players.get('diver');
  const tick = (times) => {
    for (let index = 0; index < times; index += 1) {
      clock.advance(0.05);
      scene.update();
    }
  };
  tick(5);

  const target = scene.createSnapshot().actors
    .find((actor) => actor.archetypeId === 'elastic-mushroom');
  assert.ok(target);
  player.x = target.transform.x - 0.8;
  player.z = target.transform.z;
  player.yaw = Math.PI / 2;
  tick(1);
  scene.interactWithActor('diver', { actorId: target.id, sequence: 1 });
  assert.equal(
    pullUntilDetached(scene, clock, 'diver', target.id, target.transform.x),
    true,
  );

  // 找一处水面走过去放下。
  let water;
  for (let radius = 4; radius <= 400 && !water; radius += 4) {
    for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1]]) {
      const x = target.transform.x + dx * radius;
      const z = target.transform.z + dz * radius;
      if (scene.isWaterAt(x, z)) { water = { x, z }; break; }
    }
  }
  assert.ok(water, '附近找不到水面');
  player.x = water.x;
  player.z = water.z;
  tick(4);
  assert.equal(scene.interactWithActor('diver', { actorId: target.id, sequence: 2 }), true);

  tick(80);
  const settled = scene.createSnapshot().actors.find((actor) => actor.id === target.id);
  const seaFloor = scene.actorWorld.context.groundHeightAt(settled.transform.x, settled.transform.z);
  assert.ok(
    Math.abs(settled.transform.y - seaFloor) < 0.05,
    `没有停在水底：物件在 ${settled.transform.y.toFixed(2)}，水底在 ${seaFloor.toFixed(2)}`,
  );
});
