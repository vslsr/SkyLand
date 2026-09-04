import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  Actor,
  ActorWorld,
  DROP_MOTION_COMPONENT,
  DropMotionComponent,
  ELASTIC_DETACH_COMPONENT,
  ELASTIC_TETHER_COMPONENT,
  ElasticDetachComponent,
  ElasticTetherComponent,
  TRANSFORM_COMPONENT,
  TransformComponent,
} from '../shared/actor/index.mjs';
import { ActorTransformSystem } from '../src/actors/systems/ActorTransformSystem';
import { ActorVisualParamSystem } from '../src/actors/systems/ActorVisualParamSystem';
import { RenderTransformSyncSystem } from '../src/actors/systems/RenderTransformSyncSystem';
import { RenderProxyComponent } from '../src/actors/components/RenderProxyComponent';
import { RenderTransformBuffer } from '../src/render/RenderTransformBuffer';
import type { ThreeMeshProxy } from '../src/render/three/ThreeMeshProxy';
import { RenderProxyTable } from '../src/render/RenderProxyTable';
import { ThreeRenderScene } from '../src/render/three/ThreeRenderScene';
import { ActorSnapshotBuffer } from '../src/actors/ActorSnapshotBuffer';
import type { ClientActorSystem } from '../src/actors/ClientActorSystem';
import { createTestActorSystem, stepActorFrame } from './renderProxyProbe';
import type { SceneDefinition } from '../src/scenes/data/SceneDefinition';
import { INTERPOLATION_DELAY_MS } from '../shared/networkTuning.mjs';
import type { SnapshotActor } from '../src/network/protocol';
import { ActorInteractionController } from '../src/controllers/ActorInteractionController';
import type { InputSubsystem } from '../src/input/index';
import type { ActorInteractionCandidate } from '../src/scene/SceneVisualSystem';

const ENVIRONMENT = { fogColor: '#ffffff', fogNear: 20, fogFar: 60 } as const;
const RENDER = {
  model: 'line-art-elastic-mushroom',
  capColor: '#c97868',
  stemColor: '#eadfc5',
  spotColor: '#f8f1df',
  radius: 0.5,
  height: 0.95,
} as const;
const DROP_RADIUS = 0.28;
/** 与 elastic-mushroom.actor.json 保持一致：叼住之后还要再拉这么远才拔断。 */
const PULL_DISTANCE = 2.8;

/**
 * 弹性拉伸与脱落翻滚都搬进了渲染世界（实现路径文档 §1.75），所以这里跑的是
 * 完整的那条链路：Actor 组件 → 参数段 → 翻面 → 渲染侧表现。`step()` 就是一帧。
 */
function createMushroom(): {
  world: ActorWorld;
  actor: Actor;
  scene: ThreeRenderScene;
  render: ThreeMeshProxy;
  step: (deltaSeconds: number, elapsedSeconds: number) => void;
} {
  const world = new ActorWorld();
  // 模型住在渲染世界里，Actor 只拿 proxyId（引擎迁移路线图 第 1 步）。
  const scene = new ThreeRenderScene(new THREE.Group(), ENVIRONMENT);
  const transforms = new RenderTransformBuffer();
  world.addSystem(new ActorTransformSystem(transforms));
  world.addSystem(new ActorVisualParamSystem(transforms));
  world.addSystem(new RenderTransformSyncSystem(transforms, scene));
  const actor = new Actor('elastic-mushroom-01', 'elastic-mushroom');
  actor.addComponent(new TransformComponent({ position: [1, 0, 2], yaw: 0 }));
  actor.addComponent(new ElasticTetherComponent({
    restLength: 0.72,
    breakLength: 1.55,
    pullDistance: PULL_DISTANCE,
  }));
  actor.addComponent(new ElasticDetachComponent({}));
  actor.addComponent(new DropMotionComponent({
    gravity: 9.8,
    drag: 1.8,
    radius: DROP_RADIUS,
    settleSpeed: 0.1,
  }));
  const proxyIds = new RenderProxyTable(scene);
  const proxyId = proxyIds.acquire();
  scene.createMeshProxy(proxyId, { name: 'actor-elastic-mushroom-01', render: RENDER });
  actor.addComponent(new RenderProxyComponent(proxyId, scene));
  const render = scene.resolve(proxyId) as ThreeMeshProxy;
  world.addActor(actor);
  const step = (deltaSeconds: number, elapsedSeconds: number): void => {
    world.update(deltaSeconds, elapsedSeconds);
    scene.updateVisuals(transforms, deltaSeconds, elapsedSeconds);
  };
  // 先兑现一帧：根节点的位置来自 SoA，后面的世界坐标断言要建立在它之上。
  step(0, 0);
  return { world, actor, scene, render, step };
}

/** 菌盖中心在世界空间里的位置，用来判断蘑菇到底是立着还是躺着。 */
function capWorldPosition(render: ThreeMeshProxy): THREE.Vector3 {
  const rig = render.elasticTetherRig;
  assert.ok(rig);
  render.root.updateWorldMatrix(true, true);
  return rig.capRoot.getWorldPosition(new THREE.Vector3());
}

test('蘑菇模型提供绕刚体球心的翻滚枢轴', () => {
  const { render } = createMushroom();
  const rig = render.dropRollRig;
  assert.ok(rig, '蘑菇没有 dropRollRig');
  assert.equal(rig.pivotRoot.position.y, 0);
  assert.equal(rig.bodyRoot.position.y, 0);
});

test('还长在地上时翻滚表现不改姿态', () => {
  const { render, step } = createMushroom();
  step(1 / 60, 0);
  // 断言只看翻滚枢轴：菌盖的世界坐标同一帧还被弹性拉伸的闲置摆动动着，
  // 那是另一项表现的正常输出，不是这条用例要证的事。
  const rig = render.dropRollRig;
  assert.ok(rig);
  assert.equal(rig.pivotRoot.position.y, 0);
  assert.equal(rig.bodyRoot.position.y, 0);
  assert.ok(rig.pivotRoot.quaternion.equals(new THREE.Quaternion()), '未脱落却被摆了姿态');
});

test('脱落后按刚体朝向翻倒，且绕球心而不是绕菌柄根部', () => {
  const { actor, render, step } = createMushroom();
  const upright = capWorldPosition(render);

  (actor.requireComponent(ELASTIC_DETACH_COMPONENT) as ElasticDetachComponent).markDetached();
  const motion = actor.requireComponent(DROP_MOTION_COMPONENT) as DropMotionComponent;
  // 绕 X 轴翻 90°：蘑菇整株躺倒。
  const half = Math.SQRT1_2;
  motion.setRotation({ x: half, y: 0, z: 0, w: half });
  step(1 / 60, 0);

  // 半径经参数段过了一次 f32：0.28 在 f32 里是 0.28000000119…，按 f32 容差比。
  const rig = render.dropRollRig;
  assert.ok(Math.abs((rig?.pivotRoot.position.y ?? 0) - DROP_RADIUS) < 1e-6);
  assert.ok(Math.abs((rig?.bodyRoot.position.y ?? 0) + DROP_RADIUS) < 1e-6);

  const toppled = capWorldPosition(render);
  // 立着时菌盖在球心正上方；翻 90° 之后它应该跑到球心的水平方向上。
  assert.ok(toppled.y < upright.y - 0.4, `菌盖没有倒下来：y=${toppled.y} vs ${upright.y}`);
  assert.ok(
    Math.hypot(toppled.x - 1, toppled.z - 2) > 0.4,
    `菌盖没有横过去：${toppled.toArray()}`,
  );
  // 球心固定在 Actor 原点上方 radius 处，翻滚不该把整株蘑菇甩出去。
  const pivot = new THREE.Vector3(1, DROP_RADIUS, 2);
  assert.ok(
    Math.abs(toppled.distanceTo(pivot) - upright.distanceTo(pivot)) < 1e-6,
    '翻滚改变了菌盖到球心的距离，说明枢轴不在球心上',
  );
});

test('脱落之后弹性拉伸表现交出姿态，不再把蘑菇掰回竖直', () => {
  const { actor, render, step } = createMushroom();
  const rig = render.elasticTetherRig;
  assert.ok(rig);

  // 先拉伸一帧，制造出非静止的拉伸姿态。
  const tether = actor.requireComponent(ELASTIC_TETHER_COMPONENT) as ElasticTetherComponent;
  tether.holderPlayerId = 'player-a';
  tether.targetX = 2.4;
  tether.targetY = 1.1;
  tether.targetZ = 2;
  step(1 / 60, 0);
  assert.ok(rig.stemRoot.scale.y !== 1, '拉伸没有生效，后续断言没有意义');

  (actor.requireComponent(ELASTIC_DETACH_COMPONENT) as ElasticDetachComponent).markDetached();
  tether.holderPlayerId = null;
  step(1 / 60, 1 / 60);

  assert.equal(rig.stemRoot.scale.y, 1);
  assert.ok(rig.elasticRoot.quaternion.equals(new THREE.Quaternion()), '菌柄仍被拉伸表现扭着');

  const motion = actor.requireComponent(DROP_MOTION_COMPONENT) as DropMotionComponent;
  const half = Math.SQRT1_2;
  motion.setRotation({ x: half, y: 0, z: 0, w: half });
  // 再跑一帧：拉伸必须继续放手，翻滚姿态要留得住。
  step(1 / 60, 2 / 60);
  assert.ok(
    Math.abs(render.dropRollRig!.pivotRoot.quaternion.x - half) < 1e-6,
    '翻滚姿态被拉伸表现盖掉了',
  );
});

test('两份快照之间对朝向做球面插值，并且走近路', () => {
  const buffer = new ActorSnapshotBuffer();
  const half = Math.SQRT1_2;
  const frame = (
    serverTime: number,
    rotation: readonly [number, number, number, number],
  ): SnapshotActor[] => [{
    id: 'elastic-mushroom-01',
    archetypeId: 'elastic-mushroom',
    parentActorId: null,
    revision: 1,
    transform: { x: 0, y: 0, z: 0, yaw: 0 },
    elasticDetach: { detached: true, revision: 1, rotation },
  } as unknown as SnapshotActor];

  const base = 1_000_000;
  // receivedAt 取成 serverTime，让两端时钟偏移为 0，采样时刻好推。
  // 第二帧刻意取等价但符号相反的四元数：线性插值会绕远路，slerp 必须走近路。
  buffer.push(frame(base, [0, 0, 0, 1]), base, base);
  buffer.push(frame(base + 100, [-half, 0, 0, -half]), base + 100, base + 100);

  const sampled = buffer.sample(base + 50 + INTERPOLATION_DELAY_MS);
  const rotation = sampled[0]?.elasticDetach?.rotation;
  assert.ok(rotation, '采样结果没有朝向');
  assert.ok(Math.abs(Math.hypot(...rotation) - 1) < 1e-9, '插值结果没有归一化');
  // 走近路时中点是绕 X 轴 45°，x 分量为正。
  assert.ok(rotation[0] > 0.2, `绕了远路：${rotation.join(',')}`);
  assert.ok(Math.abs(rotation[0] - Math.sin(Math.PI / 8)) < 0.02, rotation.join(','));
});

test('被叼住拖拽期间仍然归弹性拉伸管，翻滚表现不插手', () => {
  const { actor, render, step } = createMushroom();
  const rig = render.elasticTetherRig;
  assert.ok(rig);

  const tether = actor.requireComponent(ELASTIC_TETHER_COMPONENT) as ElasticTetherComponent;
  tether.holderPlayerId = 'player-a';
  tether.targetX = 2.1;
  tether.targetY = 1.05;
  tether.targetZ = 2;

  // 即使刚体朝向字段里有值，只要还没拔断就不该被用上。
  const motion = actor.requireComponent(DROP_MOTION_COMPONENT) as DropMotionComponent;
  motion.setRotation({ x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 });

  for (let frame = 0; frame < 20; frame += 1) step(1 / 60, frame / 60);

  assert.ok(rig.stemRoot.scale.y !== 1, '拉伸表现被翻滚表现顶掉了');
  assert.ok(
    render.dropRollRig!.pivotRoot.quaternion.equals(new THREE.Quaternion()),
    '还没拔断就开始翻滚了',
  );
  assert.equal(render.dropRollRig!.pivotRoot.position.y, 0);
  assert.equal(render.dropRollRig!.bodyRoot.position.y, 0);
});

test('拉到最长时菌盖仍然长在菌柄顶端，不会脱开', () => {
  const { actor, render, step } = createMushroom();
  const rig = render.elasticTetherRig;
  assert.ok(rig);

  const tether = actor.requireComponent(ELASTIC_TETHER_COMPONENT) as ElasticTetherComponent;
  tether.holderPlayerId = 'player-a';
  // 顶着交互距离叼住，再拉满整段拖拽行程：这是弹性能到的最长状态。
  tether.grabLength = 1.03;
  tether.targetX = 1;
  tether.targetY = 20;
  tether.targetZ = 2;
  for (let frame = 0; frame < 240; frame += 1) step(1 / 60, frame / 60);

  const stemTop = rig.restLength * rig.stemRoot.scale.y;
  assert.ok(
    Math.abs(rig.capRoot.position.y - stemTop) < 1e-6,
    `菌盖悬空了：菌盖在 ${rig.capRoot.position.y.toFixed(3)}m，菌柄顶端在 ${stemTop.toFixed(3)}m`,
  );
  // 拉伸倍率必须真的越过旧的写死上限 4.2，否则这条用例根本没碰到回归点。
  assert.ok(
    stemTop > rig.restLength * 4.2,
    `没有拉到旧上限之外，用例失去意义：${stemTop.toFixed(2)}m`,
  );
});

test('手上有蘑菇时，交互键让开：叼着的那株归丢出键，拉着的那株才归它', () => {
  const sent: string[] = [];
  let prompt: string | undefined;
  let held: ActorInteractionCandidate | undefined;
  let nearby: ActorInteractionCandidate | undefined;
  const input = {
    enabled: true,
    bind: (_tag: unknown, handler: () => void) => {
      trigger = handler;
      return () => undefined;
    },
  } as unknown as InputSubsystem;
  let trigger: () => void = () => undefined;
  const controller = new ActorInteractionController(input, {
    getPlayerId: () => 'me',
    getPlayerPosition: () => ({ x: 0, z: 0 }),
    findOwnedActorId: () => undefined,
    pick: () => undefined,
    findNearby: () => nearby,
    findHeld: () => held,
    getInputLabel: () => 'E',
    setHoveredActorId: () => undefined,
    sendInteraction: (actorId) => sent.push(actorId),
    setPrompt: (text) => { prompt = text; },
  });
  const frame = {} as never;
  const candidate = (over: Partial<ActorInteractionCandidate>): ActorInteractionCandidate => ({
    actorId: 'm1',
    label: '弹弹菇',
    action: 'mushroom-bite',
    carrierActorId: null,
    holderPlayerId: null,
    pickupHolderActorId: null,
    ...over,
  });

  // 叼在嘴上：放下归丢出键（Q），交互键完全让开——它得能在手上有东西时照常
  // 够到脚下那堆货。让它占住候选的话，手上一有东西，交互键就废了一半。
  held = candidate({ pickupHolderActorId: 'me' });
  nearby = candidate({ actorId: 'pile-1', action: 'pickup-stack', quantity: 3 });
  trigger();
  controller.update(frame);
  assert.match(prompt ?? '', /拾取/, '提示说的是够得到的那堆货，不是手上那件');
  assert.deepEqual(sent, ['pile-1'], '一次按下只做一件事：捡起脚下那堆');

  // 手上叼着、周围又没有别的可交互：交互键这时没有对象，什么都不做。
  sent.length = 0;
  nearby = undefined;
  trigger();
  controller.update(frame);
  assert.deepEqual(sent, []);

  // 拉着还没断：提示松开，按键同样指向它，即使它已经被拖出就近搜索半径。
  // 这一支不是「放下手上那件」，所以仍然按下即发。
  sent.length = 0;
  held = candidate({ holderPlayerId: 'me' });
  nearby = undefined;
  trigger();
  controller.update(frame);
  assert.match(prompt ?? '', /松开/);
  assert.deepEqual(sent, ['m1']);

  // 手上没东西时回到就近拾取，别人叼着的那株按不动。
  sent.length = 0;
  held = undefined;
  nearby = candidate({ actorId: 'm2', holderPlayerId: 'someone-else' });
  trigger();
  controller.update(frame);
  assert.deepEqual(sent, []);
  assert.match(prompt ?? '', /正被叼住/);

  sent.length = 0;
  nearby = candidate({ actorId: 'm3' });
  trigger();
  controller.update(frame);
  assert.deepEqual(sent, ['m3']);
  assert.match(prompt ?? '', /叼住/);
  controller.dispose();
});

test('端到端：快照说我叼着它，按下交互键不再当场放下', () => {
  const definition = {
    schemaVersion: 1,
    id: 'grassland',
    displayName: 'x',
    description: 'x',
    capacity: 8,
    sceneComponents: [],
    actors: [],
    actorArchetypes: [{
      schemaVersion: 1,
      id: 'elastic-mushroom',
      components: {
        interactable: { action: 'mushroom-bite', label: '弹弹菇', maximumDistance: 1.35 },
        elasticTether: {
          restLength: 0.72,
          breakLength: 1.55,
          pullDistance: PULL_DISTANCE,
        },
        elasticDetach: {},
        dropMotion: {
          gravity: 9.8, drag: 1.8, groundDrag: 7, restitution: 0.28,
          radius: DROP_RADIUS, angularDamping: 0.35, settleSpeed: 0.1,
        },
        replicationPolicy: { mode: 'aoi', radiusChunks: 1 },
        render: RENDER,
      },
    }],
    renderer: {},
    gameplay: {
      playerActor: { archetypeId: 'player-slime' },
      worldProps: {},
      bounds: { minimumX: -10, maximumX: 10, minimumZ: -10, maximumZ: 10 },
    },
  } as unknown as SceneDefinition;

  const mushroom = (over: Record<string, unknown>): SnapshotActor => ({
    id: 'm1',
    archetypeId: 'elastic-mushroom',
    parentActorId: null,
    revision: 1,
    transform: { x: 0, y: 0, z: 0, yaw: 0 },
    localTransform: { x: 0, y: 0, z: 0, yaw: 0 },
    // 叼住之后 interactable 是关的：靠就近搜索永远找不到它。
    interactable: {
      action: 'mushroom-bite', label: '弹弹菇', enabled: false,
      maximumDistance: 1.35, revision: 1,
    },
    elasticTether: {
      holderPlayerId: null, targetX: 0, targetY: 0.72, targetZ: 0,
      releaseRevision: 0, revision: 1,
    },
    elasticDetach: { detached: false, revision: 1 },
    ...over,
  } as unknown as SnapshotActor);

  let now = 1_000;
  const system = createTestActorSystem({
    definition,
    environment: ENVIRONMENT,
    now: () => now,
    // 这些用例不测建模节流：一帧建完，断言才好写。分帧建模由
    // ClientActorSystem.spawn.test.ts 单独覆盖。
    spawnBudgetMilliseconds: Number.POSITIVE_INFINITY,
  } as never);

  const sent: string[] = [];
  let trigger: () => void = () => undefined;
  const input = {
    enabled: true,
    bind: (_tag: unknown, handler: () => void) => { trigger = handler; return () => undefined; },
  } as unknown as InputSubsystem;
  const controller = new ActorInteractionController(input, {
    getPlayerId: () => 'me',
    getPlayerPosition: () => ({ x: 0, z: 0 }),
    findOwnedActorId: () => undefined,
    pick: () => undefined,
    findNearby: (position) => system.findNearbyInteractableActor(position),
    findHeld: (playerId) => system.findHeldInteractableActor(playerId),
    getInputLabel: () => 'E',
    setHoveredActorId: () => undefined,
    sendInteraction: (actorId) => sent.push(actorId),
    setPrompt: () => undefined,
  });
  const frame = {} as never;

  // 拉着还没断：按 E 应当发出取消请求。
  system.syncSnapshots([mushroom({
    elasticTether: {
      holderPlayerId: 'me', targetX: 1.2, targetY: 0.72, targetZ: 0,
      releaseRevision: 0, revision: 1,
    },
  })], now);
  stepActorFrame(system, 1 / 60, 0);
  trigger();
  controller.update(frame);
  assert.deepEqual(sent, ['m1'], '拉着时按 E 没有发出请求');

  // 叼在嘴上：按 E 应当发出放下请求。
  sent.length = 0;
  now = 2_000;
  system.syncSnapshots([mushroom({
    parentActorId: 'me',
    transform: undefined,
    localTransform: { x: 0, y: 0.3, z: 0.36, yaw: 0 },
    elasticDetach: { detached: true, revision: 2, rotation: [0, 0, 0, 1] },
  })], now, now, [{
    id: 'me', name: '我', x: 2, y: 0.1, z: 3, yaw: 0.5,
    speed: 0, ackTick: 0, sequence: 0,
  }]);
  now += INTERPOLATION_DELAY_MS;
  stepActorFrame(system, 1 / 60, 1);
  const attached = system.getActor('m1')!;
  const attachedTransform = attached.requireComponent(TRANSFORM_COMPONENT) as TransformComponent;
  assert.ok(Math.abs(attachedTransform.x - (2 + Math.sin(0.5) * 0.36)) < 1e-6);
  assert.ok(Math.abs(attachedTransform.y - 0.4) < 1e-6);
  assert.ok(Math.abs(attachedTransform.z - (3 + Math.cos(0.5) * 0.36)) < 1e-6);
  // 叼在嘴上：按下这一刻**不发**。放下与收进背包由松手时长分派，归按住路径，
  // 在这里按下就发出去等于永远走短按分支。
  trigger();
  controller.update(frame);
  assert.deepEqual(sent, [], '叼着时按下不该立刻发出放下请求');
  controller.dispose();
});
