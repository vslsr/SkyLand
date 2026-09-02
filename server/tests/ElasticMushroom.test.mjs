import assert from 'node:assert/strict';
import test from 'node:test';
import { ServerScene } from '../scene/ServerScene.mjs';
import { SceneCatalog } from '../scenes/SceneCatalog.mjs';

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
