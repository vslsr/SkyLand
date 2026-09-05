import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  HEALTH_COMPONENT,
  SIMPLE_COLLISION_COMPONENT,
} from '../shared/actor/index.mjs';
import {
  PROJECTILE_RADIUS,
  ballisticArcPoint,
  ballisticArcTangent,
} from '../shared/ballistics/index.mjs';
import { INTERPOLATION_DELAY_MS } from '../shared/networkTuning.mjs';
import type { SnapshotActor } from '../src/network/protocol';
import { RenderTransformBuffer } from '../src/render/RenderTransformBuffer';
import type { SceneDefinition } from '../src/scenes/data/SceneDefinition';
import { createTestActorSystem, renderProxyOf, stepActorFrame } from './renderProxyProbe';

/**
 * 射出去那支箭在客户端这一侧是什么（设计稿 `@w 木弓` 的 `A`）。
 *
 * 它以前是渲染世界池子里的一个对象：判定在松手那一刻早就结算完了，屏幕上那条轨迹
 * 和世界没有关系，所以它穿墙。现在它是一个**复制 Actor**——撞在哪儿、什么时候停由
 * 服务端权威决定，而**位置由客户端自己按弧求**。这一组锁住三条：
 *
 * 1. 箭不装碰撞体。一支飞在空中的箭不该挡住走路的人，也不该被准星选中挡在它身后
 *    那只史莱姆前面。这条和服务端 `ServerActorFactory` 里的判断是同一条。
 * 2. 位置不走快照插值。34 米每秒的小东西是插值最坏的情况：20 Hz 下两份快照隔着
 *    1.7 米，缓冲一空就原地冻住、下一份到了再跳过去。整条弧随快照复制过来，
 *    于是两份快照之间它照样每帧往前走一点（`ClientProjectileSystem`）。
 * 3. 箭尖朝着它正在去的方向。断言的是**箭尖在世界里指向哪儿**，不是那个欧拉角
 *    读数——正负号写反过一次，而对着实现写的断言当时跟着一起反了。
 */
const ARROW_RENDER = {
  model: 'line-art-arrow',
  length: 0.62,
  shaftColor: '#c8a06a',
  headColor: '#7a6a58',
  inkColor: '#2f2419',
} as const;

const definition = {
  schemaVersion: 1,
  id: 'projectile-probe',
  displayName: 'projectile',
  description: 'projectile replica test',
  capacity: 8,
  sceneComponents: [],
  actors: [],
  actorArchetypes: [{
    schemaVersion: 1,
    id: 'wood-arrow',
    components: {
      projectile: { speed: 34, radius: PROJECTILE_RADIUS, minimumFlightSeconds: 0.12, lingerSeconds: 1.6 },
      render: ARROW_RENDER,
    },
  }, {
    // 被射中的那一个。这里只需要它是个画得出来、走得动的 Actor。
    schemaVersion: 1,
    id: 'target-post',
    components: { render: ARROW_RENDER },
  }],
  renderer: {
    type: 'line-art',
    background: '#ffffff',
    fog: { color: '#ffffff', near: 20, far: 60 },
    content: { ground: false, trees: false, grass: false, ocean: false },
    palette: { ground: '#ffffff', grass: '#ffffff', treeTrunk: '#ffffff', treeNeedles: '#ffffff' },
  },
  gameplay: {
    playerActor: { archetypeId: 'player-slime' },
    worldProps: {},
    bounds: { minimumX: -64, maximumX: 64, minimumZ: -64, maximumZ: 64 },
  },
} as unknown as SceneDefinition;

const ORIGIN = { x: 0, y: 0.62, z: 0 };
const IMPACT = { x: 0, y: 0, z: 22 };
/** 出发那一刻的服务端秒数。测试里的服务端时钟和本地时钟对齐，见 `createSystem`。 */
const STARTED_AT = 0.5;
const FLIGHT_SECONDS = 1;

function arrow(travel: number, stopped = false): SnapshotActor {
  const point = ballisticArcPoint(arc(), travel, { x: 0, y: 0, z: 0 });
  const transform = { x: point.x, y: point.y, z: point.z, yaw: 0 };
  return {
    id: 'projectile-1',
    archetypeId: 'wood-arrow',
    parentActorId: null,
    revision: 1,
    transform,
    localTransform: transform,
    projectile: {
      originX: ORIGIN.x,
      originY: ORIGIN.y,
      originZ: ORIGIN.z,
      impactX: IMPACT.x,
      impactY: IMPACT.y,
      impactZ: IMPACT.z,
      ratio: 1,
      startedAt: STARTED_AT,
      flightSeconds: FLIGHT_SECONDS,
      travel,
      stopped,
    },
  } as unknown as SnapshotActor;
}

function arc() {
  return {
    originX: ORIGIN.x,
    originY: ORIGIN.y,
    originZ: ORIGIN.z,
    impactX: IMPACT.x,
    impactY: IMPACT.y,
    impactZ: IMPACT.z,
    ratio: 1,
  };
}

/**
 * 服务端时钟就是本地时钟：第一份快照的 `serverTime` 取当时的 `now()`，于是
 * `clockOffset` 为 0，渲染时刻正好是 `now - INTERPOLATION_DELAY_MS`。
 */
function createSystem(clock: { now: number }) {
  const transforms = new RenderTransformBuffer();
  const system = createTestActorSystem({
    definition,
    environment: { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
    now: () => clock.now,
    spawnBudgetMilliseconds: Number.POSITIVE_INFINITY,
    transforms,
  });
  return system;
}

/** 这一帧箭在世界里的位置。 */
function positionOf(system: ReturnType<typeof createSystem>) {
  const proxy = renderProxyOf(system, 'projectile-1')!;
  proxy.root.updateWorldMatrix(true, true);
  return new THREE.Vector3().setFromMatrixPosition(proxy.root.matrixWorld);
}

/** 箭尖在世界里指着哪个方向。模型沿 +Z 躺着，箭头在 +Z 那一端。 */
function tipDirectionOf(system: ReturnType<typeof createSystem>) {
  const proxy = renderProxyOf(system, 'projectile-1')!;
  // 弓箭模型的 `visualRoot` 就是 `projectileRig.pitchRoot`（见 `createArrowModel`）。
  proxy.visualRoot.updateWorldMatrix(true, true);
  return new THREE.Vector3(0, 0, 1)
    .transformDirection(proxy.visualRoot.matrixWorld)
    .normalize();
}

test('箭的副本不装碰撞体：飞在空中的箭不该挡住走路的人', () => {
  const clock = { now: 1_000 };
  const system = createSystem(clock);
  system.syncSnapshots([arrow(0)], clock.now);
  stepActorFrame(system, 0, 0);

  const actor = system.getActor('projectile-1')!;
  assert.equal(actor.getComponent(SIMPLE_COLLISION_COMPONENT), undefined);
  assert.ok(renderProxyOf(system, 'projectile-1'), '但它仍然是画得出来的');
  // 没有生命值：一支箭钉在另一支箭上说不通，它也不该出现在弹药的候选目标里。
  assert.equal(actor.getComponent(HEALTH_COMPONENT), undefined);
  // 也就不在「挡住弹道的实体」这条查询里。
  assert.equal(system.sweepProjectileTargets([0, 1.2, -3], [0, 1.2, 3], PROJECTILE_RADIUS), 1);
});

test('两份快照之间箭照样往前走：位置是从弧上解析求的，不是插出来的', () => {
  const clock = { now: 1_000 };
  const system = createSystem(clock);
  // 只有这一份快照。插值那条路到这里就没有输入了——它会一直交出这一帧、
  // 箭原地冻住，那正是画面上那阵抖的来源。
  system.syncSnapshots([arrow(0)], clock.now);

  const seen: number[] = [];
  for (let frame = 0; frame < 30; frame += 1) {
    clock.now += 16;
    stepActorFrame(system, 0.016, frame * 0.016);
    seen.push(positionOf(system).z);
  }

  for (let index = 1; index < seen.length; index += 1) {
    assert.ok(seen[index] > seen[index - 1], `第 ${index} 帧停住了：${seen[index - 1]} → ${seen[index]}`);
  }

  // 而且落在那条弧上，不是随便往前挪。
  const elapsed = (clock.now - INTERPOLATION_DELAY_MS) / 1000 - STARTED_AT;
  const expected = ballisticArcPoint(arc(), elapsed / FLIGHT_SECONDS, { x: 0, y: 0, z: 0 });
  const actual = positionOf(system);
  assert.ok(Math.abs(actual.z - expected.z) < 1e-3, `z 偏了：${actual.z} vs ${expected.z}`);
  assert.ok(Math.abs(actual.y - expected.y) < 1e-3, `y 偏了：${actual.y} vs ${expected.y}`);
});

test('箭尖指着切线：上升段仰着、下落段扎着', () => {
  const clock = { now: 1_000 };
  const system = createSystem(clock);
  system.syncSnapshots([arrow(0)], clock.now);

  const sampleAt = (travelWanted: number) => {
    clock.now = (STARTED_AT + travelWanted * FLIGHT_SECONDS) * 1000 + INTERPOLATION_DELAY_MS;
    stepActorFrame(system, 0.016, 0);
    return tipDirectionOf(system);
  };

  for (const travel of [0.1, 0.35, 0.5, 0.8, 0.95]) {
    const tip = sampleAt(travel);
    const tangent = ballisticArcTangent(arc(), travel, { x: 0, y: 0, z: 0 });
    assert.ok(
      tip.dot(new THREE.Vector3(tangent.x, tangent.y, tangent.z)) > 0.999,
      `travel=${travel} 箭尖没沿切线：${tip.toArray().join(',')} vs ${tangent.x},${tangent.y},${tangent.z}`,
    );
  }

  assert.ok(sampleAt(0.05).y > 0.2, '刚出手那一段该仰着');
  assert.ok(sampleAt(0.95).y < -0.2, '落下来那一段该扎着');
});

test('停住之后不再往前：撞在哪儿是服务端说了算的', () => {
  const clock = { now: 1_000 };
  const system = createSystem(clock);
  system.syncSnapshots([arrow(0.4, true)], clock.now);
  clock.now += 500;
  stepActorFrame(system, 0.016, 0);
  const stopped = positionOf(system);

  clock.now += 500;
  stepActorFrame(system, 0.016, 0);
  const later = positionOf(system);
  assert.ok(later.distanceTo(stopped) < 1e-6, `停住的箭动了：${stopped.z} → ${later.z}`);

  const expected = ballisticArcPoint(arc(), 0.4, { x: 0, y: 0, z: 0 });
  assert.ok(Math.abs(stopped.z - expected.z) < 1e-3, `没停在权威说的地方：${stopped.z} vs ${expected.z}`);
});

test('扎住之后是目标下面的一个静态子 Actor：目标走了，箭跟着走', () => {
  const clock = { now: 1_000 };
  const system = createSystem(clock);
  const post = (z: number) => ({
    id: 'post-1',
    archetypeId: 'target-post',
    parentActorId: null,
    revision: 1,
    transform: { x: 0, y: 0, z, yaw: 0 },
    localTransform: { x: 0, y: 0, z, yaw: 0 },
  } as unknown as SnapshotActor);
  // 扎在柱子身上：世界坐标由服务端的挂载解算给出，本地坐标是「插进去多深」。
  const stuck = (z: number) => ({
    ...arrow(0.4, true),
    parentActorId: 'post-1',
    transform: { x: 0, y: 1.1, z: z + 0.3, yaw: 0 },
    localTransform: { x: 0, y: 1.1, z: 0.3, yaw: 0 },
  } as unknown as SnapshotActor);

  system.syncSnapshots([post(10), stuck(10)], clock.now);
  clock.now += 200;
  stepActorFrame(system, 0.016, 0);
  const before = positionOf(system);
  assert.ok(Math.abs(before.z - 10.3) < 1e-3, `该扎在柱子上，实际 ${before.z}`);

  // 柱子往前走了两米。箭是它的子 Actor，所以一起走——而不是钉死在命中时
  // 那个世界点上（那正是「箭留在半空」的老毛病）。
  clock.now += 200;
  system.syncSnapshots([post(12), stuck(12)], clock.now);
  clock.now += 200;
  stepActorFrame(system, 0.016, 0);
  const after = positionOf(system);
  assert.ok(Math.abs(after.z - 12.3) < 1e-3, `箭没跟着目标走，停在 ${after.z}`);
});

test('切线就是弧的导数：拿差分对，不拿实现自己对自己', () => {
  // 这一条防的是上一次那种错：断言照着实现写，实现的正负号反了，断言跟着一起反。
  const step = 1e-4;
  const at = (t: number) => ballisticArcPoint(arc(), t, { x: 0, y: 0, z: 0 });
  for (const t of [0.05, 0.5, 0.95]) {
    const before = at(t - step);
    const after = at(t + step);
    const length = Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z);
    const tangent = ballisticArcTangent(arc(), t, { x: 0, y: 0, z: 0 });
    assert.ok(Math.abs((after.y - before.y) / length - tangent.y) < 1e-6, `t=${t} 竖直分量不是导数`);
    assert.ok(Math.abs((after.z - before.z) / length - tangent.z) < 1e-6, `t=${t} 水平分量不是导数`);
  }
  // 而且方向是对的：出手抬头、落地扎下去。
  assert.ok(ballisticArcTangent(arc(), 0.05, { x: 0, y: 0, z: 0 }).y > 0);
  assert.ok(ballisticArcTangent(arc(), 0.95, { x: 0, y: 0, z: 0 }).y < 0);
});

test('模型锚在箭尖：权威位置就是这一箭的前端，杆挂在它后面', () => {
  const clock = { now: 1_000 };
  const system = createSystem(clock);
  system.syncSnapshots([arrow(0.5)], clock.now);
  clock.now += 400;
  stepActorFrame(system, 0.016, 0);

  const proxy = renderProxyOf(system, 'projectile-1')!;
  const box = new THREE.Box3().setFromObject(proxy.visualRoot);
  const origin = positionOf(system);
  // 整支箭落在权威点**后方**：最远的一端是箭尾，没有任何一段跑到点的前面去。
  // 锚在箭尾的老做法下，整支箭画在真正位置前方 0.72 米，扎中之后整根埋进目标里。
  const ahead = new THREE.Vector3(0, 0, 1)
    .transformDirection(proxy.visualRoot.matrixWorld)
    .normalize()
    .dot(box.max.clone().sub(origin));
  assert.ok(ahead < 1e-3, `有一段跑到箭尖前面去了：${ahead}`);
  assert.ok(box.min.distanceTo(box.max) > 0.5, '箭还是那么长，只是挪了锚点');
});
