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
  TransformComponent,
} from '../shared/actor/index.mjs';
import { ActorDropRollSystem } from '../src/actors/systems/ActorDropRollSystem';
import { ElasticTetherVisualSystem } from '../src/actors/systems/ElasticTetherVisualSystem';
import { ThreeObjectComponent } from '../src/actors/components/ThreeObjectComponent';
import { createElasticMushroomModel } from '../src/models/actors/createElasticMushroomModel';
import { ActorSnapshotBuffer } from '../src/actors/ActorSnapshotBuffer';
import { ClientActorSystem } from '../src/actors/ClientActorSystem';
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

function createMushroom(): { world: ActorWorld; actor: Actor; render: ThreeObjectComponent } {
  const world = new ActorWorld();
  const actor = new Actor('elastic-mushroom-01', 'elastic-mushroom');
  actor.addComponent(new TransformComponent({ position: [1, 0, 2], yaw: 0 }));
  actor.addComponent(new ElasticTetherComponent({
    restLength: 0.72,
    breakLength: 1.55,
    pullDistance: PULL_DISTANCE,
    mouthHeight: 0.3,
    mouthForwardOffset: 0.36,
  }));
  actor.addComponent(new ElasticDetachComponent({}));
  actor.addComponent(new DropMotionComponent({
    gravity: 9.8,
    drag: 1.8,
    radius: DROP_RADIUS,
    settleSpeed: 0.1,
  }));
  const render = actor.addComponent(
    new ThreeObjectComponent(createElasticMushroomModel(ENVIRONMENT, RENDER)),
  ) as ThreeObjectComponent;
  // 渲染根位置平时由 ActorTransformSystem 写；这里只测翻滚，直接摆好即可。
  render.root.position.set(1, 0, 2);
  world.addActor(actor);
  return { world, actor, render };
}

/** 菌盖中心在世界空间里的位置，用来判断蘑菇到底是立着还是躺着。 */
function capWorldPosition(render: ThreeObjectComponent): THREE.Vector3 {
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

test('还长在地上时翻滚系统不改姿态', () => {
  const { world, render } = createMushroom();
  const system = new ActorDropRollSystem();
  const before = capWorldPosition(render);
  system.update(world);
  const after = capWorldPosition(render);
  assert.ok(after.distanceTo(before) < 1e-6, `未脱落却被摆动了：${after.toArray()}`);
  assert.equal(render.dropRollRig?.pivotRoot.position.y, 0);
});

test('脱落后按刚体朝向翻倒，且绕球心而不是绕菌柄根部', () => {
  const { world, actor, render } = createMushroom();
  const system = new ActorDropRollSystem();
  const upright = capWorldPosition(render);

  (actor.requireComponent(ELASTIC_DETACH_COMPONENT) as ElasticDetachComponent).markDetached();
  const motion = actor.requireComponent(DROP_MOTION_COMPONENT) as DropMotionComponent;
  // 绕 X 轴翻 90°：蘑菇整株躺倒。
  const half = Math.SQRT1_2;
  motion.setRotation({ x: half, y: 0, z: 0, w: half });
  system.update(world);

  const rig = render.dropRollRig;
  assert.equal(rig?.pivotRoot.position.y, DROP_RADIUS);
  assert.equal(rig?.bodyRoot.position.y, -DROP_RADIUS);

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
  const { world, actor, render } = createMushroom();
  const tetherVisual = new ElasticTetherVisualSystem();
  const rollSystem = new ActorDropRollSystem();
  const rig = render.elasticTetherRig;
  assert.ok(rig);

  // 先拉伸一帧，制造出非静止的拉伸姿态。
  const tether = actor.requireComponent(ELASTIC_TETHER_COMPONENT) as ElasticTetherComponent;
  tether.holderPlayerId = 'player-a';
  tether.targetX = 2.4;
  tether.targetY = 1.1;
  tether.targetZ = 2;
  tetherVisual.update(world, 1 / 60, 0);
  assert.ok(rig.stemRoot.scale.y !== 1, '拉伸没有生效，后续断言没有意义');

  (actor.requireComponent(ELASTIC_DETACH_COMPONENT) as ElasticDetachComponent).markDetached();
  tether.holderPlayerId = null;
  tetherVisual.update(world, 1 / 60, 1 / 60);

  assert.equal(rig.stemRoot.scale.y, 1);
  assert.ok(rig.elasticRoot.quaternion.equals(new THREE.Quaternion()), '菌柄仍被拉伸系统扭着');

  const motion = actor.requireComponent(DROP_MOTION_COMPONENT) as DropMotionComponent;
  const half = Math.SQRT1_2;
  motion.setRotation({ x: half, y: 0, z: 0, w: half });
  rollSystem.update(world);
  // 再跑一帧拉伸系统：它必须继续放手，翻滚姿态要留得住。
  tetherVisual.update(world, 1 / 60, 2 / 60);
  assert.ok(
    Math.abs(render.dropRollRig!.pivotRoot.quaternion.x - half) < 1e-6,
    '翻滚姿态被拉伸系统盖掉了',
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

test('被叼住拖拽期间仍然归弹性拉伸管，翻滚系统不插手', () => {
  const { world, actor, render } = createMushroom();
  const tetherVisual = new ElasticTetherVisualSystem();
  const rollSystem = new ActorDropRollSystem();
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

  for (let frame = 0; frame < 20; frame += 1) {
    tetherVisual.update(world, 1 / 60, frame / 60);
    rollSystem.update(world);
  }

  assert.ok(rig.stemRoot.scale.y !== 1, '拉伸表现被翻滚系统顶掉了');
  assert.ok(
    render.dropRollRig!.pivotRoot.quaternion.equals(new THREE.Quaternion()),
    '还没拔断就开始翻滚了',
  );
  assert.equal(render.dropRollRig!.pivotRoot.position.y, 0);
  assert.equal(render.dropRollRig!.bodyRoot.position.y, 0);
});

test('拉到最长时菌盖仍然长在菌柄顶端，不会脱开', () => {
  const { world, actor, render } = createMushroom();
  const tetherVisual = new ElasticTetherVisualSystem();
  const rig = render.elasticTetherRig;
  assert.ok(rig);

  const tether = actor.requireComponent(ELASTIC_TETHER_COMPONENT) as ElasticTetherComponent;
  tether.holderPlayerId = 'player-a';
  // 顶着交互距离叼住，再拉满整段拖拽行程：这是弹性能到的最长状态。
  tether.grabLength = 1.03;
  tether.targetX = 1;
  tether.targetY = 20;
  tether.targetZ = 2;
  for (let frame = 0; frame < 240; frame += 1) {
    tetherVisual.update(world, 1 / 60, frame / 60);
  }

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

test('手上有蘑菇时，交互键指向它并给出放下/松开提示', () => {
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
    carriedByPlayerId: null,
    ...over,
  });

  // 叼在嘴上：提示放下，按键指向它自己。
  held = candidate({ carriedByPlayerId: 'me' });
  trigger();
  controller.update(frame);
  assert.match(prompt ?? '', /放下/);
  assert.deepEqual(sent, ['m1']);

  // 拉着还没断：提示松开，按键同样指向它，即使它已经被拖出就近搜索半径。
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

test('端到端：快照说我叼着它，按一次交互键就发出放下请求', () => {
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
          mouthHeight: 0.3,
          mouthForwardOffset: 0.36,
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
    elasticDetach: { detached: false, carriedByPlayerId: null, revision: 1 },
    ...over,
  } as unknown as SnapshotActor);

  let now = 1_000;
  const system = new ClientActorSystem({
    definition,
    environment: ENVIRONMENT,
    now: () => now,
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
  system.update(1 / 60, 0);
  trigger();
  controller.update(frame);
  assert.deepEqual(sent, ['m1'], '拉着时按 E 没有发出请求');

  // 叼在嘴上：按 E 应当发出放下请求。
  sent.length = 0;
  now = 2_000;
  system.syncSnapshots([mushroom({
    elasticDetach: { detached: true, carriedByPlayerId: 'me', revision: 2, rotation: [0, 0, 0, 1] },
  })], now);
  system.update(1 / 60, 1);
  trigger();
  controller.update(frame);
  assert.deepEqual(sent, ['m1'], '叼着时按 E 没有发出请求');
  controller.dispose();
});
