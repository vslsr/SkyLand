import assert from 'node:assert/strict';
import test from 'node:test';
import './initRapier.mjs';
import { PatrolPathComponent, TRANSFORM_COMPONENT } from '../../shared/actor/index.mjs';
import { SceneCatalog } from '../scenes/SceneCatalog.mjs';
import { ServerScene } from '../scene/ServerScene.mjs';

function walkTo(patrol, seconds, step = 1 / 30) {
  const pose = { x: 0, y: 0, z: 0, yaw: 0, hasHeading: false, moving: false };
  for (let elapsed = 0; elapsed < seconds - 1e-9; elapsed += step) patrol.advance(step, pose);
  return pose;
}

test('巡逻路线来回走：走到端点掉头，朝向跟着掉过来', () => {
  const patrol = new PatrolPathComponent({
    waypoints: [[0, 0, -3], [0, 0, 3]],
    speed: 2,
    mode: 'ping-pong',
  });
  patrol.captureOrigin({ x: 5, y: 0, z: 0, yaw: 0 });

  // 3 秒走完 6 米，正好到另一端。
  const arrived = walkTo(patrol, 3);
  assert.ok(Math.abs(arrived.z - 3) < 1e-6, `应当走到 +3，实际 ${arrived.z}`);
  assert.ok(Math.abs(arrived.x - 5) < 1e-9, '横向不该漂移');

  // 再走 1.5 秒：已经掉头，回到中点，朝向翻了 180°。
  const returning = walkTo(patrol, 1.5);
  assert.ok(Math.abs(returning.z - 0) < 1e-6, `应当回到中点，实际 ${returning.z}`);
  assert.ok(Math.abs(Math.abs(returning.yaw) - Math.PI) < 1e-6, '回程朝向应当是 ±π');

  // 一个完整来回之后回到起点，误差不随时间累积。
  const cycled = walkTo(patrol, 1.5);
  assert.ok(Math.abs(cycled.z + 3) < 1e-6, `应当回到 -3，实际 ${cycled.z}`);
});

test('路点在 Actor 局部空间：同一条路线换个朝向摆就是另一条巡逻线', () => {
  const patrol = new PatrolPathComponent({
    waypoints: [[0, 0, -4], [0, 0, 4]],
    speed: 2,
    mode: 'ping-pong',
  });
  // 摆在 (4.5, -6) 并转 90°：局部的 ±Z 变成世界的 ±X。
  patrol.captureOrigin({ x: 4.5, y: 0, z: -6, yaw: Math.PI / 2 });

  const pose = { x: 0, y: 0, z: 0, yaw: 0, hasHeading: false, moving: false };
  patrol.advance(0, pose);
  assert.ok(Math.abs(pose.x - 0.5) < 1e-6, `起点应当在 x=0.5，实际 ${pose.x}`);
  assert.ok(Math.abs(pose.z + 6) < 1e-6, `起点应当在 z=-6，实际 ${pose.z}`);

  const middle = walkTo(patrol, 2);
  assert.ok(Math.abs(middle.x - 4.5) < 1e-6, `应当沿世界 X 走到 4.5，实际 ${middle.x}`);
  assert.ok(Math.abs(middle.z + 6) < 1e-6, '这条线上 Z 不该变');
});

test('原点只抓一次；Actor 被路线推着走也不会把路线一起带跑', () => {
  const patrol = new PatrolPathComponent({
    waypoints: [[0, 0, 0], [0, 0, 5]],
    speed: 1,
    mode: 'ping-pong',
  });
  patrol.captureOrigin({ x: 0, y: 0, z: 0, yaw: 0 });
  walkTo(patrol, 2);
  // 再抓一次就等于把路线挪到当前位置——System 靠 hasOrigin 拦住这件事。
  assert.equal(patrol.hasOrigin, true);
  const end = walkTo(patrol, 3);
  assert.ok(Math.abs(end.z - 5) < 1e-6, `终点应当仍是 z=5，实际 ${end.z}`);
});

test('到站会停一会儿，停的时候不算在移动中', () => {
  const patrol = new PatrolPathComponent({
    waypoints: [[0, 0, 0], [0, 0, 2]],
    speed: 2,
    waitSeconds: 0.5,
    mode: 'ping-pong',
  });
  patrol.captureOrigin({ x: 0, y: 0, z: 0, yaw: 0 });

  // 1 秒走 2 米刚好到端点；再多走一点确保跨过了那一帧。
  const arrived = walkTo(patrol, 1.1);
  assert.ok(Math.abs(arrived.z - 2) < 1e-6, `应当停在端点，实际 ${arrived.z}`);
  assert.equal(arrived.moving, false, '到站之后应当在等待');

  // 等待期间原地不动。
  const waiting = walkTo(patrol, 0.3);
  assert.ok(Math.abs(waiting.z - 2) < 1e-6, `等待期间不该移动，实际 ${waiting.z}`);
  assert.equal(waiting.moving, false);

  const resumed = walkTo(patrol, 0.5);
  assert.equal(resumed.moving, true);
  assert.ok(resumed.z < 1.9, `等完应当往回走，实际 ${resumed.z}`);
});

test('环线模式绕回起点而不是掉头', () => {
  const patrol = new PatrolPathComponent({
    waypoints: [[0, 0, 0], [3, 0, 0], [3, 0, 3]],
    speed: 3,
    mode: 'loop',
  });
  patrol.captureOrigin({ x: 0, y: 0, z: 0, yaw: 0 });

  // 3 + 3 + |(3,3)| = 6 + 4.2426…；走满一圈回到起点。
  const perimeter = 3 + 3 + Math.hypot(3, 3);
  const looped = walkTo(patrol, perimeter / 3, 1 / 240);
  assert.ok(Math.hypot(looped.x, looped.z) < 0.05, `应当绕回起点附近，实际 (${looped.x}, ${looped.z})`);
});

test('软体测试场景里的巡逻史莱姆真的会来回走，并进入快照', async () => {
  const catalog = await SceneCatalog.load();
  let now = 1_000_000;
  const scene = new ServerScene(catalog.require('pbf-slime-test'), { now: () => now });

  const walker = scene.actorWorld.getActor('legged-slime-walker-near');
  assert.ok(walker, '场景里应当有这只巡逻史莱姆');
  const transform = walker.requireComponent(TRANSFORM_COMPONENT);
  const startZ = transform.z;
  assert.ok(Math.abs(transform.x + 4.5) < 1e-9);

  const observed = [];
  for (let step = 0; step < 400; step += 1) {
    now += 50;
    scene.update();
    observed.push(transform.z);
  }
  const minimum = Math.min(...observed);
  const maximum = Math.max(...observed);
  // 局部路线是 z ∈ [-4, 4]，摆在 z=0 上，所以世界范围也是 [-4, 4]。
  assert.ok(maximum > startZ + 3, `应当走到远端，实际最大 ${maximum}`);
  assert.ok(minimum < startZ - 3, `应当折返回来，实际最小 ${minimum}`);
  assert.ok(maximum <= 4 + 1e-6 && minimum >= -4 - 1e-6, '不该走出配置的路线');

  // 玩家 Actor 走独立 players 快照，巡逻者不是玩家，必须走 actors 快照复制出去。
  const snapshot = scene.createSnapshot();
  const replicated = snapshot.actors.find((actor) => actor.id === 'legged-slime-walker-near');
  assert.ok(replicated, '巡逻史莱姆必须出现在 actors 快照里');
  assert.ok(Math.abs(replicated.transform.z - transform.z) < 1e-6);

  // 碰撞体跟着走：巡逻排在 colliderIndex 之前，不能停在上一帧的位置上。
  let found = false;
  scene.actorWorld.context.collision.forEachNear(
    transform.x,
    transform.z,
    0.1,
    undefined,
    (instance) => {
      if (instance.actor?.id === 'legged-slime-walker-near') found = true;
    },
  );
  assert.ok(found, '碰撞体应当停在这只史莱姆当前所在的位置');
});
