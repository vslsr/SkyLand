import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { HEALTH_COMPONENT, type HealthComponent } from '../shared/actor/index.mjs';
import {
  HealthPopupEmitter,
  healthPopupAnchorY,
} from '../src/health/HealthPopupEmitter';
import {
  DeathCollapseTimer,
  LEGGED_DEATH_COLLAPSE_SECONDS,
  PBF_DEATH_COLLAPSE_SECONDS,
} from '../src/render/RenderDeathCollapse';
import { RenderProxyTable } from '../src/render/RenderProxyTable';
import { RenderTransformBuffer } from '../src/render/RenderTransformBuffer';
import { PARAM_HEALTH_DEATH_REVISION } from '../src/render/RenderVisualParams';
import { SLIME_MOTION_AT_REST, writeSlimeMotionParams } from '../src/render/RenderSlimeMotion';
import {
  SLIME_GROUND_PROBE_AT_REST,
  writeSlimeGroundProbeParams,
} from '../src/render/RenderSlimeLegs';
import { ThreeRenderScene } from '../src/render/three/ThreeRenderScene';
import type { ProxyId } from '../src/render/RenderScene';
import type { SnapshotHealth } from '../src/network/protocol';
import type { ActorRenderDefinition, SceneDefinition } from '../src/scenes/data/SceneDefinition';
import { createTestActorSystem, renderProxyOf, stepActorFrame } from './renderProxyProbe';

const ENVIRONMENT = { fogColor: '#ffffff', fogNear: 20, fogFar: 60 };

const LEGGED_SLIME = {
  model: 'line-art-legged-slime',
  radius: 0.44,
  hipHeight: 0.66,
  legSpread: 0.16,
  legCount: 2,
  thighLength: 0.42,
  shinLength: 0.42,
  legThickness: 0.028,
  footLength: 0.13,
  stepLength: 0.28,
  stepHeight: 0.13,
  stepDuration: 0.22,
  membraneColor: '#7fd4e8',
  middleColor: '#b6e9f4',
  coreColor: '#3ea9c6',
  bubbleColor: '#eafaff',
  inkColor: '#000000',
  shadowColor: '#1e4a5a',
  legColor: '#000000',
  footShadowColor: '#6f6f6f',
} as const satisfies Extract<ActorRenderDefinition, { model: 'line-art-legged-slime' }>;

function health(overrides: Partial<SnapshotHealth> = {}): SnapshotHealth {
  return {
    current: 100,
    maximum: 100,
    dead: false,
    deathRevision: 0,
    lastDelta: 0,
    eventRevision: 0,
    revision: 0,
    ...overrides,
  };
}

// --- 飘字：什么时候弹，什么时候不弹 -----------------------------------------

test('第一次看到一个实体不弹飘字，之后每变一次事件计数弹一条', () => {
  const spawned: Array<[number, number, number, number]> = [];
  const emitter = new HealthPopupEmitter({
    spawnHealthPopup: (x, y, z, amount) => spawned.push([x, y, z, amount]),
  });

  // 中途进房间：这一具已经挨过打了，不该把过去的伤害补演一遍。
  emitter.observe('slime', health({ current: 70, lastDelta: -30, eventRevision: 3 }), 1, 0, 2, 1.2);
  assert.deepEqual(spawned, []);

  emitter.observe('slime', health({ current: 45, lastDelta: -25, eventRevision: 4 }), 1, 0, 2, 1.2);
  assert.deepEqual(spawned, [[1, 1.2, 2, -25]], '飘字从头顶飞出来，量与符号照抄 lastDelta');

  // 同一份快照重复应用（10Hz 的快照会被渲染帧读到很多次）不该弹第二条。
  emitter.observe('slime', health({ current: 45, lastDelta: -25, eventRevision: 4 }), 1, 0, 2, 1.2);
  assert.equal(spawned.length, 1);

  emitter.observe('slime', health({ current: 60, lastDelta: 15, eventRevision: 5 }), 1, 0, 2, 1.2);
  assert.deepEqual(spawned.at(-1), [1, 1.2, 2, 15], '治疗是正数，走同一条路');

  // 走出视野再回来算「重新认识」：它这段时间挨的打不补演。
  emitter.forget('slime');
  emitter.observe('slime', health({ current: 10, lastDelta: -50, eventRevision: 9 }), 1, 0, 2, 1.2);
  assert.equal(spawned.length, 2);
});

test('飘字起飞高度盖过模型，长腿的按髋高算', () => {
  assert.ok(healthPopupAnchorY(LEGGED_SLIME) > LEGGED_SLIME.hipHeight);
  // 没有 render 定义也要给一个能用的高度，而不是 0（数字埋在脚底下）。
  assert.ok(healthPopupAnchorY(undefined) >= 0.6);
});

// --- 一次性死亡动画的计时 ---------------------------------------------------

test('死亡计时器：活着是 0，计数一变就从头走完，走完停在 1', () => {
  const timer = new DeathCollapseTimer();
  assert.equal(timer.update(0, 1 / 60, 0.6), 0);
  assert.equal(timer.dead, false);

  assert.equal(timer.update(1, 0, 0.6), 0, '触发那一帧还没走时间');
  assert.equal(timer.dead, true);

  // 单帧最多推进 0.1 秒：卡顿一下不该让倒下的动作瞬移到底。
  assert.ok(Math.abs(timer.update(1, 5, 0.6) - 0.1 / 0.6) < 1e-6);

  // 之后按帧走：进度单调、到 0.6 秒收在 1，不循环。
  let previous = 0.1 / 0.6;
  let frames = 0;
  while (previous < 1 && frames < 120) {
    const next = timer.update(1, 1 / 60, 0.6);
    assert.ok(next >= previous, '进度不该倒退');
    previous = next;
    frames += 1;
  }
  assert.equal(previous, 1);
  assert.ok(frames <= Math.ceil(0.5 * 60) + 1, `剩下的 0.5 秒内应当走完，实际 ${frames} 帧`);
  assert.equal(timer.update(1, 1 / 60, 0.6), 1, '走完就停在结尾');
});

test('走进视野时早就死透的那一具直接摆成塌完的样子，不当着人重演一遍', () => {
  const timer = new DeathCollapseTimer();
  // 第一次看到它就带着非零计数：AOI 进出会让这件事反复发生。
  assert.equal(timer.update(7, 1 / 60, 0.6), 1);
  assert.equal(timer.dead, true);
  assert.equal(timer.update(7, 1 / 60, 0.6), 1);
});

test('槽位被回收给另一个 proxy（计数归零）时表现从头开始', () => {
  const timer = new DeathCollapseTimer();
  timer.update(0, 1 / 60, 0.6);
  timer.update(1, 0.6, 0.6);
  assert.equal(timer.dead, true);
  assert.equal(timer.update(0, 1 / 60, 0.6), 0, '归零就是「这个槽位上换了个活着的东西」');
  assert.equal(timer.dead, false);
});

// --- 软体史莱姆：摊成一滩 ---------------------------------------------------

interface DeathHarness {
  scene: ThreeRenderScene;
  id: ProxyId;
  step(seconds: number, deathRevision: number): void;
}

const PBF_SLIME = {
  model: 'line-art-pbf-slime',
  radius: 0.95,
  collisionRadius: 0.52,
  collisionHeight: 0.72,
  particleCount: 72,
  constraintIterations: 2,
  gravity: 9.8,
  centerForce: 22,
  viscosity: 10,
  bubbleCount: 9,
  bubbleSpeed: 0.1,
  surfaceColor: '#90ebcb',
  innerColor: '#3ca98e',
  highlightColor: '#d8fff0',
  bubbleColor: '#e8fff8',
  inkColor: '#142f2b',
  shadowColor: '#7bd3bd',
} as const satisfies Extract<ActorRenderDefinition, { model: 'line-art-pbf-slime' }>;

function createPbfDeathHarness(): DeathHarness {
  const transforms = new RenderTransformBuffer(8);
  const scene = new ThreeRenderScene(new THREE.Group(), ENVIRONMENT);
  const proxyId = new RenderProxyTable(scene).acquire();
  scene.createPlayerProxy(proxyId, { name: 'pbf', render: PBF_SLIME, walkSpeed: 3.2 });
  let elapsed = 0;
  return {
    scene,
    id: proxyId,
    step(seconds, deathRevision) {
      transforms.write(proxyId, 0, 0, 0, 0);
      writeSlimeMotionParams(transforms, proxyId, SLIME_MOTION_AT_REST);
      transforms.writeParam(proxyId, PARAM_HEALTH_DEATH_REVISION, deathRevision);
      transforms.publish();
      scene.submitTransforms(transforms);
      elapsed += seconds;
      scene.updateVisuals(transforms, seconds, elapsed);
    },
  };
}

/** 外壳这一帧铺了多宽、鼓了多高。读的是求解器每帧改写的那份顶点。 */
function measureSurface(harness: DeathHarness): { planar: number; height: number } {
  const rig = harness.scene.resolve(harness.id)!.pbfSlimeVisualRig!;
  const positions = rig.surfacePosition.array as Float32Array;
  let planar = 0;
  let height = 0;
  for (let offset = 0; offset < positions.length; offset += 3) {
    planar = Math.max(planar, Math.hypot(positions[offset], positions[offset + 2]));
    height = Math.max(height, positions[offset + 1]);
  }
  return { planar, height };
}

test('软体史莱姆死后摊成一滩：横向铺开、整团压向地面', () => {
  const harness = createPbfDeathHarness();
  for (let step = 0; step < 30; step += 1) harness.step(1 / 60, 0);
  const alive = measureSurface(harness);

  const frames = Math.ceil(PBF_DEATH_COLLAPSE_SECONDS * 60) + 120;
  for (let step = 0; step < frames; step += 1) harness.step(1 / 60, 1);
  const dead = measureSurface(harness);

  assert.ok(dead.height < alive.height * 0.6, `应当塌下去，实际 ${alive.height} → ${dead.height}`);
  assert.ok(dead.planar > alive.planar * 1.1, `应当摊开，实际 ${alive.planar} → ${dead.planar}`);
});

test('摊开有过程：塌到一半时形状停在活着与摊平之间', () => {
  const harness = createPbfDeathHarness();
  for (let step = 0; step < 30; step += 1) harness.step(1 / 60, 0);
  const alive = measureSurface(harness);

  // 半程：一次性曲线走到 PBF_DEATH_COLLAPSE_SECONDS 的一半。
  const halfFrames = Math.floor((PBF_DEATH_COLLAPSE_SECONDS / 2) * 60);
  for (let step = 0; step < halfFrames; step += 1) harness.step(1 / 60, 1);
  const half = measureSurface(harness);

  for (let step = 0; step < Math.ceil(PBF_DEATH_COLLAPSE_SECONDS * 60) + 120; step += 1) {
    harness.step(1 / 60, 1);
  }
  const full = measureSurface(harness);

  assert.ok(half.height < alive.height, '半程已经开始塌');
  assert.ok(half.height > full.height, '半程还没塌到底');
});

// --- 骨骼腿史莱姆：倒下 -----------------------------------------------------

function createLeggedDeathHarness(): DeathHarness {
  const transforms = new RenderTransformBuffer(8);
  const scene = new ThreeRenderScene(new THREE.Group(), ENVIRONMENT);
  const proxyId = new RenderProxyTable(scene).acquire();
  scene.createPlayerProxy(proxyId, { name: 'legged', render: LEGGED_SLIME, walkSpeed: 3.2 });
  let elapsed = 0;
  return {
    scene,
    id: proxyId,
    step(seconds, deathRevision) {
      transforms.write(proxyId, 0, 0, 0, 0);
      writeSlimeMotionParams(transforms, proxyId, SLIME_MOTION_AT_REST);
      writeSlimeGroundProbeParams(transforms, proxyId, {
        ...SLIME_GROUND_PROBE_AT_REST,
        radius: 0.4,
      });
      transforms.writeParam(proxyId, PARAM_HEALTH_DEATH_REVISION, deathRevision);
      transforms.publish();
      scene.submitTransforms(transforms);
      elapsed += seconds;
      scene.updateVisuals(transforms, seconds, elapsed);
    },
  };
}

function bodyOf(harness: DeathHarness): THREE.Object3D {
  const proxy = harness.scene.resolve(harness.id)!;
  let body: THREE.Object3D | undefined;
  proxy.root.traverse((object) => {
    if (object.name === 'legged-slime-body') body = object;
  });
  assert.ok(body, '长腿史莱姆应当有一个身体挂点');
  return body;
}

test('骨骼腿史莱姆死后髋部掉到贴地高度，触地那一下把身体压扁', () => {
  const harness = createLeggedDeathHarness();
  for (let step = 0; step < 30; step += 1) harness.step(1 / 60, 0);
  const body = bodyOf(harness);
  const standing = body.position.y;
  assert.ok(standing > LEGGED_SLIME.hipHeight * 0.5, '活着的时候站在腿上');
  assert.deepEqual([body.scale.x, body.scale.y], [1, 1]);

  const frames = Math.ceil(LEGGED_DEATH_COLLAPSE_SECONDS * 60) + 6;
  for (let step = 0; step < frames; step += 1) harness.step(1 / 60, 1);

  assert.ok(body.position.y < standing * 0.6, `应当掉下去，实际 ${standing} → ${body.position.y}`);
  assert.ok(body.scale.y < 1 && body.scale.x > 1, '趴下之后是压扁的，不是原样');
});

// --- 复制：Replica 收到血量之后弹字、写死亡计数 -------------------------------

const walkerArchetype: SceneDefinition['actorArchetypes'][number] = {
  schemaVersion: 1,
  id: 'legged-slime-walker',
  components: {
    health: { maximum: 100, corpseSeconds: 8 },
    render: LEGGED_SLIME,
  },
};

const definition = {
  schemaVersion: 1,
  id: 'health-test',
  displayName: '生命值',
  description: 'test',
  capacity: 8,
  sceneComponents: [],
  actors: [],
  actorArchetypes: [walkerArchetype],
  renderer: {
    type: 'line-art',
    background: '#ffffff',
    fog: { color: '#ffffff', near: 20, far: 60 },
    content: { ground: false, trees: false, grass: false, ocean: false },
    palette: { ground: '#ffffff', grass: '#ffffff', treeTrunk: '#ffffff', treeNeedles: '#ffffff' },
  },
  gameplay: {
    playerActor: { archetypeId: 'legged-slime-walker' },
    bounds: { minimumX: -10, maximumX: 10, minimumZ: -10, maximumZ: 10 },
    spawn: { centerX: 0, centerZ: 0, radius: 0, slots: 8 },
  },
  camera: { mode: 'topdown', position: [0, 5, 10], yaw: 0, pitch: 0, moveSpeed: 8 },
} satisfies SceneDefinition;

function walkerSnapshot(revision: number, snapshotHealth: SnapshotHealth) {
  return {
    id: 'walker-01',
    archetypeId: 'legged-slime-walker',
    revision,
    transform: { x: 2, y: 0, z: -3, yaw: 0 },
    localTransform: { x: 2, y: 0, z: -3, yaw: 0 },
    health: snapshotHealth,
  };
}

test('Replica 承接血量：伤害弹一条飘字，死亡写进参数段', () => {
  let now = 1_000;
  const system = createTestActorSystem({
    definition,
    environment: ENVIRONMENT,
    now: () => now,
    spawnBudgetMilliseconds: Number.POSITIVE_INFINITY,
  });
  const spawned: number[] = [];
  const scene = system.getRenderScene();
  const original = scene.spawnHealthPopup.bind(scene);
  scene.spawnHealthPopup = (x, y, z, amount) => {
    spawned.push(amount);
    original(x, y, z, amount);
  };

  /** 快照与客户端时钟一起往前走，否则插值永远停在第一份上。 */
  const receive = (revision: number, snapshotHealth: SnapshotHealth): void => {
    system.syncSnapshots([walkerSnapshot(revision, snapshotHealth)], now);
    now += 300;
    stepActorFrame(system, 1 / 60, now / 1000);
  };

  receive(1, health());
  const actor = system.getActor('walker-01')!;
  const component = actor.requireComponent(HEALTH_COMPONENT) as HealthComponent;
  assert.equal(component.maximum, 100);
  assert.equal(component.current, 100);
  assert.deepEqual(spawned, [], '第一份快照不弹：那是「认识它」而不是「它挨打了」');

  receive(2, health({ current: 70, lastDelta: -30, eventRevision: 1, revision: 1 }));
  assert.equal(component.current, 70);
  assert.deepEqual(spawned, [-30]);

  receive(3, health({
    current: 0,
    dead: true,
    deathRevision: 1,
    lastDelta: -70,
    eventRevision: 2,
    revision: 2,
  }));
  assert.equal(component.dead, true);
  assert.deepEqual(spawned, [-30, -70]);

  // 死亡计数进了参数段，渲染侧才踢得动那段一次性动画。
  const proxy = renderProxyOf(system, 'walker-01')!;
  let body: THREE.Object3D | undefined;
  proxy.root.traverse((object) => {
    if (object.name === 'legged-slime-body') body = object;
  });
  assert.ok(body, '长腿史莱姆应当有一个身体挂点');
  const standing = body.position.y;
  for (let step = 0; step < Math.ceil(LEGGED_DEATH_COLLAPSE_SECONDS * 60) + 6; step += 1) {
    now += 1000 / 60;
    stepActorFrame(system, 1 / 60, now / 1000);
  }
  assert.ok(body.position.y < standing * 0.8, `尸体应当已经倒下去了，实际 ${standing} → ${body.position.y}`);
});

test('摊开与倒下的时长是两条独立的曲线，不共用一个常数', () => {
  assert.notEqual(PBF_DEATH_COLLAPSE_SECONDS, LEGGED_DEATH_COLLAPSE_SECONDS);
});
