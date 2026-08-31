import assert from 'node:assert/strict';
import test from 'node:test';
import { BUOYANCY_COMPONENT } from '../../shared/actor/index.mjs';
import { ServerScene } from '../scene/ServerScene.mjs';
import { SceneCatalog } from '../scenes/SceneCatalog.mjs';

test('水域 JSON 生成服务端木筏 Actor 并输出权威浮力快照', async () => {
  const catalog = await SceneCatalog.load();
  const scene = new ServerScene(catalog.require('water'), { now: () => 1_000_000 });
  const [raft] = scene.createSnapshot().actors;

  assert.equal(raft.id, 'demo-raft-01');
  assert.equal(raft.archetypeId, 'raft');
  assert.deepEqual(raft.transform, { x: 0, y: 0, z: 0, yaw: 0.24 });
  assert.equal(raft.revision, 1);
  assert.equal(raft.buoyancy.state, 'afloat');
  assert.ok(raft.buoyancy.draft > 0.08 && raft.buoyancy.draft < 0.28);
  assert.ok(Number.isFinite(raft.buoyancy.staticRoll));
  assert.ok(Number.isFinite(raft.buoyancy.staticPitch));
});

test('服务端浮力只在 Component 标脏时重新结算', async () => {
  const catalog = await SceneCatalog.load();
  const scene = new ServerScene(catalog.require('water'), { now: () => 1_000_000 });
  const actor = scene.actorWorld.getActor('demo-raft-01');
  const buoyancy = actor.requireComponent(BUOYANCY_COMPONENT);

  scene.update();
  assert.equal(scene.createSnapshot().actors[0].revision, 1);

  for (const part of buoyancy.parts) part.integrity = 0;
  buoyancy.markDirty();
  scene.update();
  const [raft] = scene.createSnapshot().actors;
  assert.equal(raft.revision, 2);
  assert.equal(raft.buoyancy.state, 'sinking');
});
