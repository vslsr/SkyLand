import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActorCatalog } from '../actors/ActorCatalog.mjs';
import { BuoyancyComponent } from '../../shared/actor/components/BuoyancyComponent.mjs';

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
  assert.equal(raft.components.buoyancy.minimumDraft, 0.08);
  assert.equal(raft.components.buoyancy.maximumDraft, 0.28);
  const raftBuoyancy = new BuoyancyComponent(raft.components.buoyancy);
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
  assert.equal(mushroom.components.elasticTether.breakLength, 1.55);
  assert.equal(mushroom.components.elasticTether.pullDistance, 2.8);
  assert.equal(mushroom.components.pickupDrop, undefined);
  assert.equal(mushroom.components.dropMotion.restitution, 0.28);
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
  assert.deepEqual(player.components.pickupDrop, {
    mouthLocalX: 0,
    mouthLocalY: 0.3,
    mouthLocalZ: 0.36,
    mouthLocalYaw: 0,
  });
  assert.deepEqual(catalog.require('pbf-slime').components.pickupDrop, {
    mouthLocalX: 0,
    mouthLocalY: 0.5,
    mouthLocalZ: 0.42,
    mouthLocalYaw: 0,
  });
  assert.deepEqual(player.components.playerJump, {
    impulse: 7,
    gravity: 22,
    maximumFallSpeed: 20,
    airControl: 0.85,
  });
  assert.equal(player.components.buoyancy.parts[0].id, 'body');
  assert.equal(player.components.buoyancy.minimumDraft, 0.24);
  assert.equal(player.components.buoyancy.maximumDraft, 0.44);
  assert.equal(player.components.buoyancy.bobAmplitude, 0.22);
  assert.equal(player.components.buoyancy.bobFrequency, 0.55);
  assert.ok(player.components.buoyancy.minimumDraft > player.components.buoyancy.bobAmplitude);
  const playerBuoyancy = new BuoyancyComponent(player.components.buoyancy);

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
  assert.equal(pbfSlime.components.buoyancy.minimumDraft, 0.32);
  assert.equal(pbfSlime.components.buoyancy.maximumDraft, 0.48);
  assert.equal(pbfSlime.components.buoyancy.bobAmplitude, 0.3);
  assert.ok(pbfSlime.components.buoyancy.minimumDraft > pbfSlime.components.buoyancy.bobAmplitude);
  const pbfSlimeBuoyancy = new BuoyancyComponent(pbfSlime.components.buoyancy);
  assert.ok(Math.abs(playerBuoyancy.draft - 0.34) < 1e-9);
  assert.ok(Math.abs(pbfSlimeBuoyancy.draft - 0.4) < 1e-9);
  assert.ok(playerBuoyancy.draft > raftBuoyancy.draft);
  assert.ok(pbfSlimeBuoyancy.draft > raftBuoyancy.draft);
  assert.deepEqual(pbfSlime.components.slimeSurfaceDrag, {
    maximumDistance: 1.05,
    pullForce: 120,
    falloffExponent: 1.35,
    influenceRadius: 1.15,
  });

  const campfire = catalog.require('campfire');
  assert.equal(campfire.components.heatEmitter.power, 520);
  assert.equal(campfire.components.render.model, 'line-art-campfire');
  // 篝火点亮周围的那一份配置：纯表现，不进温度结算，光比热走得远。
  assert.equal(campfire.components.pointLight.color, '#ffb469');
  assert.equal(campfire.components.pointLight.edgeColor, '#c2551c');
  assert.equal(campfire.components.pointLight.radius, 7.5);
  assert.equal(campfire.components.pointLight.enabled, true);
  assert.ok(
    campfire.components.pointLight.radius > campfire.components.heatEmitter.radius,
    '烤不到的地方仍然该看得见火光',
  );

  const hay = catalog.require('dry-hay');
  assert.equal(hay.components.temperature.initialTemperature, 20);
  assert.equal(hay.components.combustible.ignitionTemperature, 75);
  assert.equal(hay.components.render.model, 'line-art-dry-hay');

  const guidePath = catalog.require('guide-path');
  assert.equal(guidePath.components.render, undefined);
  assert.equal(guidePath.components.guidePath.points.length, 4);
  assert.equal(guidePath.components.guidePath.autoAdvance, true);
  assert.equal(guidePath.components.guidePath.currentPointIndex, 0);
  assert.deepEqual(guidePath.components.replicationPolicy, { mode: 'aoi', radiusChunks: 2 });

  const wood = catalog.require('wood-pile');
  assert.equal(wood.components.itemStack.itemType, 'wood');
  assert.equal(wood.components.actorResidency.dormantEligible, true);
  assert.equal(wood.components.replicationPolicy.mode, 'aoi');
  assert.equal(wood.components.render.model, 'line-art-wood-pile');

  assert.equal(wood.components.itemStack.displayName, '木头');
  assert.equal(wood.components.itemStack.compatibilityKey, 'wood-standard');
  // 木头躺在地上是一根会滚的六棱柱，所以它有掉落半径与滚动阻尼。
  assert.deepEqual(wood.components.dropMotion, {
    gravity: 9.8,
    drag: 0.65,
    groundDrag: 3.1,
    restitution: 0.18,
    radius: 0.12,
    settleSpeed: 0.07,
  });

  const tree = catalog.require('generated-tree');
  // 原型只描述「它是什么」，承载哪一种物件由场景的 gameplay.worldProps 决定。
  assert.equal(tree.components.generatedProp.kind, undefined);
  assert.deepEqual(tree.components.generatedProp.drop, {
    archetypeId: 'wood-pile',
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

test('ActorCatalog 保留软体形变与咬合参数，并拒绝越界值', async () => {
  const catalog = await ActorCatalog.load();
  const pbfSlime = catalog.require('pbf-slime');
  assert.deepEqual(pbfSlime.components.softBodyDeformation, {
    breakDistance: 3.0,
    selfReportTimeoutMs: 600,
  });
  assert.deepEqual(pbfSlime.components.bite, {
    range: 1.8,
    facingDot: 0.15,
    gripDepth: 0.35,
    leashSlack: 0.2,
    leashStiffness: 90,
    leashDamping: 14,
    leashCarry: 40,
  });

  // 刚度乘固定步长超过 2 就会自激振荡，目录必须挡在这条线之前。
  const springy = structuredClone(pbfSlime);
  springy.id = 'probe-leash';
  springy.components.bite.leashStiffness = 200;
  await assert.rejects(loadSingleActor(springy), /leashStiffness 数值范围无效/);

  const noBreak = structuredClone(pbfSlime);
  noBreak.id = 'probe-soft-body';
  noBreak.components.softBodyDeformation.breakDistance = 0;
  await assert.rejects(loadSingleActor(noBreak), /breakDistance 数值范围无效/);

  const wideFacing = structuredClone(pbfSlime);
  wideFacing.id = 'probe-bite';
  wideFacing.components.bite.facingDot = 1.5;
  await assert.rejects(loadSingleActor(wideFacing), /facingDot 数值范围无效/);

  // 捏起来的那块皮比外壳还深就没有意义了：过了求解器的可见量程，每次咬都长一样。
  const deepGrip = structuredClone(pbfSlime);
  deepGrip.id = 'probe-grip';
  deepGrip.components.bite.gripDepth = 5;
  await assert.rejects(loadSingleActor(deepGrip), /gripDepth 数值范围无效/);
});

test('ActorCatalog 净化点光源配置并拒绝挂不上 proxy 的灯', async () => {
  const base = {
    schemaVersion: 1,
    id: 'probe-lantern',
    components: {
      pointLight: { color: '#ffd8a0', radius: 6, intensity: 1.2, enabled: true },
      render: {
        model: 'line-art-campfire',
        stoneColor: '#c8c0b2',
        woodColor: '#79513a',
        emberColor: '#c95d32',
        radius: 0.65,
        height: 0.45,
      },
      heatEmitter: { power: 100, radius: 2, enabled: true },
    },
  };
  const catalog = await loadSingleActor(base);
  const lantern = catalog.require('probe-lantern');
  // 选填项不写就不出现在净化结果里；默认值由通道那一侧统一补（resolvePointLightDesc）。
  assert.deepEqual(lantern.components.pointLight, {
    color: '#ffd8a0',
    radius: 6,
    intensity: 1.2,
    enabled: true,
  });

  const tooBright = structuredClone(base);
  tooBright.components.pointLight.intensity = 9;
  await assert.rejects(loadSingleActor(tooBright), /intensity 数值范围无效/);

  const badFlicker = structuredClone(base);
  badFlicker.components.pointLight.flicker = 1.4;
  await assert.rejects(loadSingleActor(badFlicker), /flicker 数值范围无效/);

  // 没有 render 就没有 proxy，这份配置会一声不响地什么都不做——死配置要当场拒绝。
  const invisible = structuredClone(base);
  delete invisible.components.render;
  delete invisible.components.heatEmitter;
  invisible.components.guidePath = {
    points: [[0, 0.45, 0], [-5, 0.45, -4]],
    curve: 'linear',
    lineColor: '#fffdf4',
    markerColor: '#fff8d6',
    lineWidth: 5,
    dashLength: 0.8,
    gapLength: 0.55,
    dashSpeed: 0.5,
    markerSize: 0.6,
    hitRadius: 1.25,
    autoAdvance: true,
    loop: true,
    enabled: true,
  };
  await assert.rejects(loadSingleActor(invisible), /pointLight 需要 render/);
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

test('ActorCatalog 净化骨骼腿史莱姆并要求腿够得到站姿落脚点', async () => {
  const catalog = await ActorCatalog.load();
  const legged = catalog.require('legged-slime');
  assert.equal(legged.components.render.model, 'line-art-legged-slime');
  assert.equal(legged.components.render.legCount, 2);
  assert.equal(legged.components.render.hipHeight, 0.66);
  // 腿属于角色墨记层：纯黑，见 src/materials/createCharacterInkMaterial.ts。
  assert.equal(legged.components.render.legColor, '#000000');
  assert.equal(legged.components.render.footShadowColor, '#6f6f6f');
  // 长腿外壳也是一种玩家外壳，所以它必须带 playerMovement。
  assert.ok(legged.components.playerMovement);

  const tooShort = structuredClone(legged);
  tooShort.id = 'probe-legged-slime';
  tooShort.components.render.thighLength = 0.3;
  tooShort.components.render.shinLength = 0.3;
  await assert.rejects(loadSingleActor(tooShort), /必须够到站姿落脚点/);

  const fractionalLegs = structuredClone(legged);
  fractionalLegs.id = 'probe-legged-slime';
  fractionalLegs.components.render.legCount = 2.5;
  await assert.rejects(loadSingleActor(fractionalLegs), /legCount 必须是整数/);

  // 同一个外壳两头都能用：带 playerMovement 是玩家，不带就是服务端推着走的生物。
  const npcShell = structuredClone(legged);
  npcShell.id = 'probe-legged-slime';
  delete npcShell.components.playerMovement;
  delete npcShell.components.playerJump;
  delete npcShell.components.pickupDrop;
  delete npcShell.components.inventory;
  const npcCatalog = await loadSingleActor(npcShell);
  assert.equal(npcCatalog.require('probe-legged-slime').components.playerMovement, undefined);
});

test('ActorCatalog 净化巡逻路线，并拒绝与玩家移动并存', async () => {
  const catalog = await ActorCatalog.load();
  const walker = catalog.require('legged-slime-walker');
  assert.equal(walker.components.patrolPath.speed, 1.6);
  assert.equal(walker.components.patrolPath.waitSeconds, 0.6);
  assert.equal(walker.components.patrolPath.mode, 'ping-pong');
  assert.deepEqual(walker.components.patrolPath.waypoints, [[0, 0, -4], [0, 0, 4]]);

  // 巡逻是服务端推着走，玩家移动是玩家自己走：同时存在就有两个人抢方向盘。
  const controlled = structuredClone(walker);
  controlled.id = 'probe-walker';
  controlled.components.playerMovement = {
    walkSpeed: 3.2,
    sprintMultiplier: 1.65,
    maximumStepHeight: 0.2,
  };
  await assert.rejects(loadSingleActor(controlled), /不能与 playerMovement 并存/);

  const stuck = structuredClone(walker);
  stuck.id = 'probe-walker';
  stuck.components.patrolPath.waypoints = [[0, 0, 2], [0, 0, 2]];
  await assert.rejects(loadSingleActor(stuck), /至少要有两个不重合的路点/);

  const single = structuredClone(walker);
  single.id = 'probe-walker';
  single.components.patrolPath.waypoints = [[0, 0, 2]];
  await assert.rejects(loadSingleActor(single), /必须是 2 到 16 个路点/);
});

test('ActorCatalog 净化弹药原型，并拒绝看不见的箭与两套积分', async () => {
  const catalog = await ActorCatalog.load();
  const arrow = catalog.require('wood-arrow');
  assert.equal(arrow.components.projectile.speed, 34);
  assert.equal(arrow.components.projectile.radius, 0.08);
  assert.equal(arrow.components.projectile.lingerSeconds, 1.6);
  assert.equal(arrow.components.render.model, 'line-art-arrow');
  // 弧、蓄力比例、射手都是运行期的事，原型里写不出来。
  assert.equal(arrow.components.projectile.ownerActorId, undefined);

  // 看不见的弹药是一次看不见的判定，也就是这套改动取代掉的那个东西。
  // 光删掉 render 会先被「至少要有一种可视来源」那条挡下，所以补一个 buildGrid
  // 让它走到弹药自己那条规则上。
  const invisible = structuredClone(arrow);
  invisible.id = 'probe-arrow';
  delete invisible.components.render;
  await assert.rejects(loadSingleActor(invisible), /至少需要 render/);
  invisible.components.buildGrid = {
    cellSize: 1, columns: 0, rows: 0, deckHeight: 0,
  };
  await assert.rejects(loadSingleActor(invisible), /projectile 需要 render/);

  // 一样东西不能既按弧飞、又按重力掉：两套积分会把权威位置各写一遍。
  const falling = structuredClone(arrow);
  falling.id = 'probe-arrow';
  falling.components.dropMotion = { gravity: 9.8, drag: 0.5, settleSpeed: 0.08 };
  await assert.rejects(loadSingleActor(falling), /不能与 dropMotion、playerMovement 并存/);

  const unknown = structuredClone(arrow);
  unknown.id = 'probe-arrow';
  unknown.components.projectile.homing = true;
  await assert.rejects(loadSingleActor(unknown), /包含未知字段：homing/);
});
