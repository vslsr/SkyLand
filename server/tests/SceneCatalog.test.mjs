import test from 'node:test';
import assert from 'node:assert/strict';
import { SceneCatalog } from '../scenes/SceneCatalog.mjs';

test('loads every selectable map from an independent scene JSON', async () => {
  const catalog = await SceneCatalog.load();
  const scenes = catalog.list();

  assert.deepEqual(
    scenes.map((scene) => scene.id),
    [
      'ability-lab',
      'grass-test',
      'grassland',
      'open-meadow',
      'open-world',
      'orchard',
      'pbf-slime-test',
      'thermal-lab',
      'water',
    ],
  );
  const abilityLab = catalog.require('ability-lab');
  assert.equal(abilityLab.capacity, 1);
  assert.equal(abilityLab.camera.mode, 'topdown');
  for (const sceneId of [
    'ability-lab',
    'grass-test',
    'grassland',
    'open-meadow',
    'open-world',
    'orchard',
    'pbf-slime-test',
    'thermal-lab',
  ]) {
    const scene = catalog.require(sceneId);
    assert.deepEqual(
      scene.camera.position,
      [5.5, 7.5, 8.5],
      `${scene.id} 应配置统一的斜向 TopDown 偏移`,
    );
  }
  assert.deepEqual(abilityLab.gameplay.playerActor, { archetypeId: 'player-slime' });
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
  assert.equal(
    abilityLab.actorArchetypes.find((actor) => actor.id === 'player-slime')
      .components.playerMovement.maximumStepHeight,
    0.2,
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
  const openWorld = catalog.require('open-world');
  assert.deepEqual(openWorld.sceneComponents[0], grassland.sceneComponents[1]);
  // 变体写在场景里；普通树占 5 份、果树占 1 份，选择由房间种子决定。
  assert.deepEqual(openWorld.gameplay.worldProps, {
    tree: [
      { archetypeId: 'generated-tree', weight: 5 },
      { archetypeId: 'fruit-tree', weight: 1 },
    ],
    rock: [{ archetypeId: 'large-rock', weight: 1 }],
    mushroom: [{ archetypeId: 'elastic-mushroom', weight: 1 }],
  });
  assert.deepEqual(openWorld.gameplay.runtimeActorArchetypes, []);
  assert.deepEqual(openWorld.actors, []);
  assert.equal(openWorld.gameplay.water.seaLevel, -0.4);
  assert.equal(openWorld.renderer.ocean.deepColor, '#2f6f96');
  assert.equal(openWorld.renderer.ocean.depthColorRange, 2.5);
  // 绑定的原型连同它的掉落一起被自动带进场景，作者不用再重复列一遍。
  const openWorldArchetypeIds = openWorld.actorArchetypes.map((archetype) => archetype.id).sort();
  for (const id of [
    'generated-tree',
    'fruit-tree',
    'wood-log',
    'fruit-pile',
    'large-rock',
    'stone-pile',
    'elastic-mushroom',
  ]) {
    assert.ok(openWorldArchetypeIds.includes(id), `${id} 应该被自动带进场景`);
  }
  const pbfSlimeTest = catalog.require('pbf-slime-test');
  assert.deepEqual(
    pbfSlimeTest.actors.map((actor) => [actor.id, actor.archetypeId]),
    [
      ['pbf-collision-dummy-center', 'training-dummy'],
      ['pbf-collision-obelisk-left', 'arcane-focus-obelisk'],
      ['pbf-collision-obelisk-right', 'arcane-focus-obelisk'],
    ],
  );
  assert.equal(
    pbfSlimeTest.actorArchetypes.find((actor) => actor.id === 'pbf-slime')
      .components.render.model,
    'line-art-pbf-slime',
  );
  assert.equal(pbfSlimeTest.gameplay.playerActor.archetypeId, 'pbf-slime');
  const thermalLab = catalog.require('thermal-lab');
  assert.deepEqual(
    thermalLab.actors.map((actor) => [actor.id, actor.archetypeId]),
    [
      ['campfire-01', 'campfire'],
      ['dry-hay-01', 'dry-hay'],
      ['dry-hay-02', 'dry-hay'],
      ['dry-hay-03', 'dry-hay'],
    ],
  );
  assert.equal(
    thermalLab.actorArchetypes.find((actor) => actor.id === 'dry-hay')
      .components.combustible.ignitionTemperature,
    75,
  );
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


test('果林把 tree 绑到可再生的果树上，和无边草原共用同一套世界生成', async () => {
  const catalog = await SceneCatalog.load();
  const orchard = catalog.require('orchard');
  assert.deepEqual(orchard.gameplay.worldProps, {
    tree: [{ archetypeId: 'fruit-tree', weight: 1 }],
    rock: [{ archetypeId: 'generated-rock', weight: 1 }],
  });

  const fruitTree = orchard.actorArchetypes.find((archetype) => archetype.id === 'fruit-tree');
  assert.equal(fruitTree.components.generatedProp.regrow.seconds, 120);
  // 可再生的没有血量，两种采集形态在配置层就是互斥的。
  assert.equal(fruitTree.components.generatedProp.maximumHealth, undefined);
  assert.ok(orchard.actorArchetypes.some((archetype) => archetype.id === 'fruit-pile'));

  // 世界生成本身不受绑定影响：两张地图的 chunk 参数完全一致。
  const openWorld = catalog.require('open-world');
  assert.deepEqual(orchard.renderer.world, openWorld.renderer.world);
  assert.deepEqual(orchard.gameplay.bounds, openWorld.gameplay.bounds);
});
