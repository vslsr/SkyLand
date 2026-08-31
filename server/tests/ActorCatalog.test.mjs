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
  assert.equal(raft.components.vesselMotor.maximumForwardSpeed, 4.2);
  assert.equal(raft.components.vesselMotor.inputTimeoutMs, 300);

  const crate = catalog.require('cargo-crate');
  assert.equal(crate.components.interactable.action, 'cargo-toggle');
  assert.equal(crate.components.cargo.mass, 55);
  assert.equal(crate.components.render.model, 'line-art-cargo-crate');

  const reef = catalog.require('reef');
  assert.equal(reef.components.hazard.partId, 'front-left-float');
  assert.equal(reef.components.render.model, 'line-art-reef');

  const mushroom = catalog.require('elastic-mushroom');
  assert.equal(mushroom.components.interactable.action, 'mushroom-bite');
  assert.equal(mushroom.components.elasticTether.breakLength, 2.65);
  assert.equal(mushroom.components.render.model, 'line-art-elastic-mushroom');

  const dummy = catalog.require('training-dummy');
  assert.equal(dummy.components.render.model, 'line-art-training-dummy');
  assert.equal(dummy.components.render.height, 2.22);

  const arcaneFocus = catalog.require('arcane-focus-obelisk');
  assert.equal(arcaneFocus.components.render.model, 'line-art-focus-obelisk');
  assert.equal(arcaneFocus.components.render.crystalColor, '#c9bad9');

  const plaque = catalog.require('ability-floor-plaque');
  assert.equal(plaque.components.render.model, 'line-art-floor-plaque');
  assert.equal(plaque.components.render.width, 3.8);
});

test('ActorCatalog 拒绝未知原型', async () => {
  const catalog = await ActorCatalog.load();
  assert.throws(() => catalog.require('missing'), /未知 Actor 原型/);
});
