import assert from 'node:assert/strict';
import test from 'node:test';
import { ActorCatalog } from '../actors/ActorCatalog.mjs';

test('ActorCatalog 加载并净化木筏原型', async () => {
  const catalog = await ActorCatalog.load();
  const raft = catalog.require('raft');

  assert.equal(raft.components.render.model, 'line-art-raft');
  assert.equal(raft.components.render.length, 4.8);
  assert.equal(raft.components.buoyancy.parts.length, 6);
  assert.ok(raft.components.buoyancy.parts.every((part) => part.integrity === 1));
});

test('ActorCatalog 拒绝未知原型', async () => {
  const catalog = await ActorCatalog.load();
  assert.throws(() => catalog.require('missing'), /未知 Actor 原型/);
});
