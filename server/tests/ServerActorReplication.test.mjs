import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUOYANCY_COMPONENT,
  SIMPLE_COLLISION_COMPONENT,
  TRANSFORM_COMPONENT,
} from '../../shared/actor/index.mjs';
import { ServerScene } from '../scene/ServerScene.mjs';
import { SceneCatalog } from '../scenes/SceneCatalog.mjs';

function createClock(startAt = 1_000_000) {
  let current = startAt;
  return {
    now: () => current,
    advance(seconds) { current += seconds * 1000; },
  };
}

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

test('能力实验室的持久测试对象全部由场景 Actor 快照生成', async () => {
  const catalog = await SceneCatalog.load();
  const scene = new ServerScene(catalog.require('ability-lab'), { now: () => 1_000_000 });
  const actors = new Map(scene.createSnapshot().actors.map((actor) => [actor.id, actor]));

  assert.deepEqual([...actors.keys()], [
    'training-dummy-01',
    'arcane-focus-01',
    'ember-focus-01',
    'ability-floor-plaque-01',
  ]);
  assert.equal(actors.get('training-dummy-01').archetypeId, 'training-dummy');
  assert.deepEqual(
    actors.get('training-dummy-01').transform,
    { x: 0, y: 0, z: -1.5, yaw: 0 },
  );
});

test('场景 JSON 的子 Actor 输出稳定局部坐标和服务端权威世界坐标', async () => {
  const catalog = await SceneCatalog.load();
  const scene = new ServerScene(catalog.require('water'), { now: () => 1_000_000 });
  let actors = new Map(scene.createSnapshot().actors.map((actor) => [actor.id, actor]));
  let raft = actors.get('demo-raft-01');
  let prop = actors.get('raft-deck-prop-01');

  assert.equal(prop.parentActorId, raft.id);
  assert.deepEqual(prop.localTransform, { x: 0.72, y: 0.62, z: -0.55, yaw: -0.1 });
  assert.ok(Math.abs(prop.transform.x - (
    raft.transform.x + Math.cos(raft.transform.yaw) * 0.72 + Math.sin(raft.transform.yaw) * -0.55
  )) < 1e-9);
  assert.ok(Math.abs(prop.transform.z - (
    raft.transform.z - Math.sin(raft.transform.yaw) * 0.72 + Math.cos(raft.transform.yaw) * -0.55
  )) < 1e-9);

  const raftTransform = scene.actorWorld
    .getActor('demo-raft-01')
    .requireComponent(TRANSFORM_COMPONENT);
  raftTransform.setWorldTransform([4, 0, -2], 0.5);
  scene.update();
  actors = new Map(scene.createSnapshot().actors.map((actor) => [actor.id, actor]));
  raft = actors.get('demo-raft-01');
  prop = actors.get('raft-deck-prop-01');
  assert.deepEqual(prop.localTransform, { x: 0.72, y: 0.62, z: -0.55, yaw: -0.1 });
  assert.ok(Math.abs(prop.transform.x - (
    raft.transform.x + Math.cos(raft.transform.yaw) * 0.72 + Math.sin(raft.transform.yaw) * -0.55
  )) < 1e-9);
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

test('Actor 控制权排他且玩家离开时自动释放', async () => {
  const catalog = await SceneCatalog.load();
  const scene = new ServerScene(catalog.require('water'), { now: () => 1_000_000 });
  scene.addPlayer({ id: 'player-a', name: 'A', slot: 0 });
  scene.addPlayer({ id: 'player-b', name: 'B', slot: 1 });

  assert.equal(scene.claimActorControl('player-a', 'demo-raft-01'), true);
  assert.equal(scene.claimActorControl('player-b', 'demo-raft-01'), false);
  assert.equal(scene.createSnapshot().actors[0].control.ownerPlayerId, 'player-a');

  scene.removePlayer('player-a');
  assert.equal(scene.createSnapshot().actors[0].control.ownerPlayerId, null);
  assert.equal(scene.claimActorControl('player-b', 'demo-raft-01'), true);
});

test('VesselMotorComponent 只接受控制者输入并由服务端 tick 推进', async () => {
  const clock = createClock();
  const catalog = await SceneCatalog.load();
  const scene = new ServerScene(catalog.require('water'), { now: clock.now });
  scene.addPlayer({ id: 'owner', name: '船长', slot: 0 });
  scene.addPlayer({ id: 'other', name: '乘客', slot: 1 });
  scene.claimActorControl('owner', 'demo-raft-01');

  assert.equal(scene.applyActorInput('other', {
    actorId: 'demo-raft-01', sequence: 1, throttle: 1, steering: 1,
  }), false);
  for (let sequence = 1; sequence <= 12; sequence += 1) {
    clock.advance(0.05);
    scene.applyActorInput('owner', {
      actorId: 'demo-raft-01', sequence, throttle: 1, steering: 0.65,
    });
    scene.update();
  }

  const moving = scene.createSnapshot().actors[0];
  assert.ok(Math.hypot(moving.transform.x, moving.transform.z) > 0.05);
  assert.notEqual(moving.transform.yaw, 0.24);
  assert.ok(moving.vessel.speed > 0);
  assert.equal(moving.vessel.throttle, 1);

  clock.advance(0.35);
  scene.update();
  assert.equal(scene.createSnapshot().actors[0].vessel.throttle, 0);
});

test('载重与损伤事件按序修改通用浮力 Component 并进入快照', async () => {
  const clock = createClock();
  const catalog = await SceneCatalog.load();
  const scene = new ServerScene(catalog.require('water'), { now: clock.now });
  scene.addPlayer({ id: 'owner', name: '船长', slot: 0 });
  scene.addPlayer({ id: 'other', name: '乘客', slot: 1 });
  scene.claimActorControl('owner', 'demo-raft-01');
  const initial = scene.createSnapshot().actors[0];

  assert.equal(scene.applyActorEvent('other', {
    actorId: 'demo-raft-01', sequence: 1,
    event: { type: 'cargo:add', cargoId: 'crate-a', mass: 60, localX: 1, localZ: 0 },
  }), false);
  assert.equal(scene.applyActorEvent('owner', {
    actorId: 'demo-raft-01', sequence: 1,
    event: { type: 'cargo:add', cargoId: 'crate-a', mass: 60, localX: 1, localZ: 0 },
  }), true);
  assert.equal(scene.applyActorEvent('owner', {
    actorId: 'demo-raft-01', sequence: 1,
    event: { type: 'cargo:add', cargoId: 'replay', mass: 500 },
  }), false);
  clock.advance(0.05);
  scene.update();
  const loaded = scene.createSnapshot().actors[0];
  assert.equal(loaded.buoyancy.cargoMass, 60);
  assert.equal(loaded.buoyancy.eventRevision, 1);
  assert.deepEqual(loaded.buoyancy.lastEvent, { type: 'cargo:add', targetId: 'crate-a' });
  assert.ok(loaded.buoyancy.draft > initial.buoyancy.draft);

  assert.equal(scene.applyActorEvent('owner', {
    actorId: 'demo-raft-01', sequence: 2,
    event: { type: 'damage', partId: 'front-left-float', amount: 1 },
  }), true);
  clock.advance(0.05);
  scene.update();
  const damaged = scene.createSnapshot().actors[0];
  assert.equal(damaged.buoyancy.damagedPartCount, 1);
  assert.equal(damaged.buoyancy.eventRevision, 2);
  assert.ok(damaged.buoyancy.speedFactor < loaded.buoyancy.speedFactor);

  assert.equal(scene.applyActorEvent('owner', {
    actorId: 'demo-raft-01', sequence: 3,
    event: { type: 'cargo:remove', cargoId: 'crate-a' },
  }), true);
  clock.advance(0.05);
  scene.update();
  assert.equal(scene.createSnapshot().actors[0].buoyancy.cargoMass, 0);
});

test('场景货箱交互完成权威距离校验、装载附着和卸载闭环', async () => {
  const clock = createClock();
  const catalog = await SceneCatalog.load();
  const scene = new ServerScene(catalog.require('water'), { now: clock.now });
  scene.addPlayer({ id: 'owner', name: '船长', slot: 0 });
  scene.addPlayer({ id: 'other', name: '旁观者', slot: 1 });
  scene.claimActorControl('owner', 'demo-raft-01');

  assert.equal(scene.interactWithActor('other', {
    actorId: 'cargo-crate-01', sequence: 1,
  }), false);
  assert.equal(scene.interactWithActor('owner', {
    actorId: 'cargo-crate-01', sequence: 1,
  }), true);
  assert.equal(scene.interactWithActor('owner', {
    actorId: 'cargo-crate-01', sequence: 1,
  }), false);
  clock.advance(0.05);
  scene.update();

  let actors = new Map(scene.createSnapshot().actors.map((actor) => [actor.id, actor]));
  assert.equal(actors.get('cargo-crate-01').cargo.carrierActorId, 'demo-raft-01');
  assert.equal(actors.get('cargo-crate-01').parentActorId, 'demo-raft-01');
  assert.deepEqual(actors.get('cargo-crate-01').localTransform, {
    x: -0.55, y: 0.62, z: 0.55, yaw: 0,
  });
  assert.equal(actors.get('demo-raft-01').buoyancy.cargoMass, 55);
  assert.equal(actors.get('demo-raft-01').buoyancy.lastEvent.type, 'cargo:add');
  assert.ok(Math.hypot(
    actors.get('cargo-crate-01').transform.x - actors.get('demo-raft-01').transform.x,
    actors.get('cargo-crate-01').transform.z - actors.get('demo-raft-01').transform.z,
  ) < 2);

  assert.equal(scene.interactWithActor('owner', {
    actorId: 'cargo-crate-01', sequence: 2,
  }), true);
  clock.advance(0.05);
  scene.update();
  actors = new Map(scene.createSnapshot().actors.map((actor) => [actor.id, actor]));
  assert.equal(actors.get('cargo-crate-01').cargo.carrierActorId, null);
  assert.equal(actors.get('cargo-crate-01').parentActorId, null);
  assert.equal(actors.get('demo-raft-01').buoyancy.cargoMass, 0);

  const cargoTransform = scene.actorWorld
    .getActor('cargo-crate-02')
    .requireComponent(TRANSFORM_COMPONENT);
  cargoTransform.x = 30;
  cargoTransform.z = 30;
  assert.equal(scene.interactWithActor('owner', {
    actorId: 'cargo-crate-02', sequence: 3,
  }), false);
});

test('礁石碰撞由服务端按冷却触发浮筒损伤', async () => {
  const clock = createClock();
  const catalog = await SceneCatalog.load();
  const scene = new ServerScene(catalog.require('water'), { now: clock.now });
  const raftTransform = scene.actorWorld
    .getActor('demo-raft-01')
    .requireComponent(TRANSFORM_COMPONENT);
  raftTransform.x = 1.2;
  raftTransform.z = 5.2;

  clock.advance(0.05);
  scene.update();
  let raft = scene.createSnapshot().actors.find((actor) => actor.id === 'demo-raft-01');
  assert.equal(raft.buoyancy.damagedPartCount, 1);
  assert.deepEqual(raft.buoyancy.lastEvent, {
    type: 'damage', targetId: 'front-left-float',
  });
  const firstEventRevision = raft.buoyancy.eventRevision;

  clock.advance(0.5);
  scene.update();
  raft = scene.createSnapshot().actors.find((actor) => actor.id === 'demo-raft-01');
  assert.equal(raft.buoyancy.eventRevision, firstEventRevision);

  clock.advance(1.2);
  scene.update();
  raft = scene.createSnapshot().actors.find((actor) => actor.id === 'demo-raft-01');
  assert.equal(raft.buoyancy.eventRevision, firstEventRevision + 1);
});

test('玩家移动由房间 DS 按 Actor 模型生成的简易碰撞权威推出', async () => {
  const clock = createClock();
  const catalog = await SceneCatalog.load();
  const scene = new ServerScene(catalog.require('water'), { now: clock.now });
  scene.addPlayer({ id: 'walker', name: '碰撞测试', slot: 0 });
  const player = scene.players.get('walker');
  const cargo = scene.actorWorld.getActor('cargo-crate-01');
  const transform = cargo.requireComponent(TRANSFORM_COMPONENT);
  const collision = cargo.requireComponent(SIMPLE_COLLISION_COMPONENT);
  const clearance = collision.halfWidth + 0.42;
  const cosYaw = Math.cos(transform.yaw);
  const sinYaw = Math.sin(transform.yaw);
  player.x = transform.x - cosYaw * (clearance + 0.05);
  player.z = transform.z + sinYaw * (clearance + 0.05);

  scene.applyInput('walker', {
    sequence: 1,
    deltaSeconds: 0.1,
    move: { x: cosYaw, z: -sinYaw },
    sprint: false,
    yaw: 0,
  });

  const deltaX = player.x - transform.x;
  const deltaZ = player.z - transform.z;
  const localX = cosYaw * deltaX - sinYaw * deltaZ;
  assert.ok(localX <= -clearance + 1e-6);
});
