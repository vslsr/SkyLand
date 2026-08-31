import test from 'node:test';
import assert from 'node:assert/strict';
import { SceneCatalog } from '../scenes/SceneCatalog.mjs';

test('loads every selectable map from an independent scene JSON', async () => {
  const catalog = await SceneCatalog.load();
  const scenes = catalog.list();

  assert.deepEqual(
    scenes.map((scene) => scene.id),
    ['ability-lab', 'grass-test', 'grassland', 'open-meadow', 'open-world', 'water'],
  );
  const abilityLab = catalog.require('ability-lab');
  assert.equal(abilityLab.capacity, 1);
  assert.equal(abilityLab.camera.mode, 'topdown');
  assert.deepEqual(abilityLab.sceneComponents, [{
    type: 'ability-lab',
    targetActorId: 'training-dummy-01',
  }]);
  assert.deepEqual(
    abilityLab.actors.map((actor) => [actor.id, actor.archetypeId]),
    [
      ['training-dummy-01', 'training-dummy'],
      ['arcane-focus-01', 'arcane-focus-obelisk'],
      ['ember-focus-01', 'ember-focus-obelisk'],
      ['ability-floor-plaque-01', 'ability-floor-plaque'],
    ],
  );
  assert.equal(
    abilityLab.actorArchetypes.find((actor) => actor.id === 'training-dummy')
      .components.render.model,
    'line-art-training-dummy',
  );
  const grassTest = catalog.require('grass-test');
  assert.equal(grassTest.renderer.content.grass, true);
  assert.deepEqual(grassTest.sceneComponents, [{ type: 'mouse-grass-interaction' }]);
  assert.equal(grassTest.renderer.content.trees, false);
  assert.equal(grassTest.renderer.content.ocean, false);
  assert.equal(grassTest.camera.mode, 'topdown');
  const grassland = catalog.require('grassland');
  assert.equal(grassland.renderer.type, 'line-art');
  assert.deepEqual(grassland.sceneComponents[1], {
    type: 'interactive-particle-effect',
    id: 'grassland-leaves',
    preset: 'line-art-leaves',
    position: [0, 0, 1.5],
    particleCount: 180,
    radius: 8,
    seed: 139732,
    fillColor: '#d6a45b',
    accentColor: '#bd7041',
    lineColor: '#493426',
    interactionRadius: 0.9,
    impulseStrength: 3.4,
  });
  assert.equal(catalog.require('open-meadow').renderer.content.trees, false);
  assert.deepEqual(catalog.require('open-world').sceneComponents, []);
  const water = catalog.require('water');
  assert.equal(water.camera.mode, 'fly');
  assert.equal(water.renderer.content.ocean, true);
  assert.equal(water.gameplay.water.seaLevel, 0);
  assert.equal(water.renderer.ocean.noiseStrength, 1.15);
  assert.equal(water.renderer.ocean.segments, 28);
  assert.equal(water.renderer.ocean.interlaceStrength, 0.42);
  assert.deepEqual(water.actors[0], {
    id: 'demo-raft-01',
    archetypeId: 'raft',
    parentActorId: null,
    localTransform: { position: [0, 0, 0], yaw: 0.24 },
  });
  assert.equal(water.actorArchetypes[0].id, 'raft');
});

test('rejects unknown scene ids instead of silently selecting another map', async () => {
  const catalog = await SceneCatalog.load();
  assert.throws(() => catalog.require('missing-map'), /请选择有效的地图/);
});

test('流式场景带上 world 配置，固定场景没有', async () => {
  const catalog = await SceneCatalog.load();
  const openWorld = catalog.require('open-world');

  assert.equal(openWorld.renderer.world.loadRadius, 2);
  assert.equal(openWorld.renderer.world.keepRadius, 3);
  assert.equal(catalog.require('grassland').renderer.world, undefined);
});
