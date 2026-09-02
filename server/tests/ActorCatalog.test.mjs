import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActorCatalog } from '../actors/ActorCatalog.mjs';

async function loadSingleActor(definition) {
  const directory = await mkdtemp(join(tmpdir(), 'skyland-actor-'));
  await writeFile(join(directory, 'probe.actor.json'), JSON.stringify(definition), 'utf8');
  return ActorCatalog.load(directory);
}

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

  const player = catalog.require('player-slime');
  assert.equal(player.components.render.model, 'line-art-player-slime');
  assert.equal(player.components.render.radius, 0.42);
  assert.equal(player.components.playerMovement.walkSpeed, 3.2);
  assert.equal(player.components.playerMovement.maximumStepHeight, 0.2);
  assert.deepEqual(player.components.playerJump, {
    impulse: 7,
    gravity: 22,
    maximumFallSpeed: 20,
    airControl: 0.85,
  });
  assert.equal(player.components.buoyancy.parts[0].id, 'body');
  assert.equal(player.components.buoyancy.minimumDraft, 0.08);
  assert.equal(player.components.buoyancy.bobAmplitude, 0.22);
  assert.equal(player.components.buoyancy.bobFrequency, 0.55);

  const pbfSlime = catalog.require('pbf-slime');
  assert.equal(pbfSlime.components.render.model, 'line-art-pbf-slime');
  assert.equal(pbfSlime.components.render.collisionRadius, 0.52);
  assert.equal(pbfSlime.components.render.collisionHeight, 0.72);
  assert.equal(pbfSlime.components.render.particleCount, 72);
  assert.equal(pbfSlime.components.render.constraintIterations, 2);
  assert.equal(pbfSlime.components.render.gravity, 9.8);
  assert.equal(pbfSlime.components.render.centerForce, 22);
  assert.equal(pbfSlime.components.playerMovement.walkSpeed, 3.2);
  assert.equal(pbfSlime.components.playerMovement.maximumStepHeight, 0.2);
  assert.equal(pbfSlime.components.playerJump.impulse, 7);
  assert.equal(pbfSlime.components.playerJump.airControl, 0.85);
  assert.equal(pbfSlime.components.buoyancy.parts[0].buoyancy, 80);
  assert.equal(pbfSlime.components.buoyancy.bobAmplitude, 0.3);
  assert.deepEqual(pbfSlime.components.slimeSurfaceDrag, {
    maximumDistance: 0.62,
    pullForce: 72,
    falloffExponent: 2.2,
    influenceRadius: 0.52,
  });

  const campfire = catalog.require('campfire');
  assert.equal(campfire.components.heatEmitter.power, 520);
  assert.equal(campfire.components.render.model, 'line-art-campfire');

  const hay = catalog.require('dry-hay');
  assert.equal(hay.components.temperature.initialTemperature, 20);
  assert.equal(hay.components.combustible.ignitionTemperature, 75);
  assert.equal(hay.components.render.model, 'line-art-dry-hay');

  const guidePath = catalog.require('guide-path');
  assert.equal(guidePath.components.render, undefined);
  assert.equal(guidePath.components.guidePath.points.length, 4);
  assert.equal(guidePath.components.guidePath.autoAdvance, true);
  assert.equal(guidePath.components.guidePath.currentPointIndex, 0);

  const wood = catalog.require('wood-pile');
  assert.equal(wood.components.itemStack.itemType, 'wood');
  assert.equal(wood.components.actorResidency.dormantEligible, true);
  assert.equal(wood.components.replicationPolicy.mode, 'aoi');
  assert.equal(wood.components.render.model, 'line-art-wood-pile');

  const woodLog = catalog.require('wood-log');
  assert.equal(woodLog.components.itemStack.itemType, 'wood-log');
  assert.equal(woodLog.components.itemStack.displayName, '圆木');
  assert.equal(woodLog.components.itemStack.compatibilityKey, 'wood-log');
  assert.equal(woodLog.components.render.model, 'line-art-wood-log');
  assert.deepEqual(woodLog.components.dropMotion, {
    gravity: 9.8,
    drag: 0.65,
    groundDrag: 3.1,
    restitution: 0.18,
    radius: 0.11,
    settleSpeed: 0.07,
  });

  const tree = catalog.require('generated-tree');
  // 原型只描述「它是什么」，承载哪一种物件由场景的 gameplay.worldProps 决定。
  assert.equal(tree.components.generatedProp.kind, undefined);
  assert.deepEqual(tree.components.generatedProp.drop, {
    archetypeId: 'wood-log',
    quantity: 5,
    spawnPattern: 'center-scatter',
  });
  assert.equal(tree.components.interactable.action, 'harvest-prop');

  const fruitTree = catalog.require('fruit-tree');
  assert.deepEqual(fruitTree.components.generatedProp.drop, {
    archetypeId: 'fruit-pile',
    quantity: 3,
    spawnPattern: 'fruit-anchors',
  });
  const fruit = catalog.require('fruit-pile');
  assert.deepEqual(fruit.components.dropMotion, {
    gravity: 9.8,
    drag: 0.45,
    groundDrag: 2.4,
    restitution: 0.28,
    radius: 0.14,
    settleSpeed: 0.08,
  });
});

test('ActorCatalog 拒绝缺失的掉落配置与不成对的采集交互', async () => {
  const base = {
    schemaVersion: 1,
    id: 'generated-probe',
    components: {
      interactable: { action: 'harvest-prop', label: '探针', maximumDistance: 2 },
      generatedProp: {
        maximumHealth: 3,
        harvestDamage: 1,
        drop: { archetypeId: 'wood-pile', quantity: 5 },
      },
      replicationPolicy: { mode: 'aoi', radiusChunks: 2 },
    },
  };
  await loadSingleActor(base);

  const missingDrop = structuredClone(base);
  delete missingDrop.components.generatedProp.drop;
  await assert.rejects(loadSingleActor(missingDrop), /drop 必须是对象/);

  // 生成物件与 harvest-prop 交互必须成对出现，少一半就没有入口或没有状态。
  const wrongAction = structuredClone(base);
  wrongAction.components.interactable.action = 'cargo-toggle';
  await assert.rejects(loadSingleActor(wrongAction), /需要 harvest-prop interactable/);

  const wrongSpawnPattern = structuredClone(base);
  wrongSpawnPattern.components.generatedProp.drop.spawnPattern = 'teleport';
  await assert.rejects(
    loadSingleActor(wrongSpawnPattern),
    /spawnPattern 必须是 center、center-scatter 或 fruit-anchors/,
  );
});

test('ActorCatalog 拒绝缺少温度的可燃物和倒置的点燃阈值', async () => {
  const missingTemperature = {
    schemaVersion: 1,
    id: 'bad-hay',
    components: {
      combustible: {
        ignitionTemperature: 75,
        extinguishTemperature: 45,
        fuel: 10,
        burnRate: 1,
        heatOutput: 100,
        heatRadius: 2,
      },
      render: {
        model: 'line-art-floor-plaque',
        color: '#ffffff',
        accentColor: '#333333',
        width: 1,
        length: 1,
        height: 0.1,
      },
    },
  };
  await assert.rejects(loadSingleActor(missingTemperature), /combustible 需要 temperature/);

  const reversedThreshold = structuredClone(missingTemperature);
  reversedThreshold.components.temperature = {
    initialTemperature: 20,
    ambientTemperature: 20,
    heatCapacity: 10,
    coolingRate: 0.1,
  };
  reversedThreshold.components.combustible.extinguishTemperature = 80;
  await assert.rejects(loadSingleActor(reversedThreshold), /必须小于 ignitionTemperature/);
});

test('ActorCatalog 拒绝未知原型', async () => {
  const catalog = await ActorCatalog.load();
  assert.throws(() => catalog.require('missing'), /未知 Actor 原型/);
});

test('ActorCatalog 拒绝越界的玩家台阶高度和错误的玩家渲染组合', async () => {
  const base = {
    schemaVersion: 1,
    id: 'probe-player',
    components: {
      playerMovement: { walkSpeed: 3.2, sprintMultiplier: 1.65, maximumStepHeight: 0.2 },
      render: {
        model: 'line-art-player-slime',
        radius: 0.42,
        membraneColor: '#4fd695',
        middleColor: '#8ce8b6',
        coreColor: '#2fbb7c',
        bubbleColor: '#eafff2',
        inkColor: '#173a2b',
        shadowColor: '#1e5a40',
      },
    },
  };
  const tooHigh = structuredClone(base);
  tooHigh.components.playerMovement.maximumStepHeight = 2.01;
  await assert.rejects(loadSingleActor(tooHigh), /maximumStepHeight 数值范围无效/);

  const wrongRender = structuredClone(base);
  wrongRender.components.render = {
    model: 'line-art-floor-plaque',
    color: '#ffffff',
    accentColor: '#333333',
    width: 1,
    length: 1,
    height: 0.1,
  };
  await assert.rejects(loadSingleActor(wrongRender), /需要玩家史莱姆 render/);

  const catalog = await ActorCatalog.load();
  const outsideSkin = structuredClone(catalog.require('pbf-slime'));
  outsideSkin.id = 'probe-hybrid-slime';
  outsideSkin.components.render.collisionHeight = outsideSkin.components.render.radius;
  await assert.rejects(loadSingleActor(outsideSkin), /collisionHeight 必须低于外部蒙皮顶部/);
});
