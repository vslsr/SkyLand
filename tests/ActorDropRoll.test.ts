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
import { INTERPOLATION_DELAY_MS } from '../shared/networkTuning.mjs';
import type { SnapshotActor } from '../src/network/protocol';

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

function createMushroom(): { world: ActorWorld; actor: Actor; render: ThreeObjectComponent } {
  const world = new ActorWorld();
  const actor = new Actor('elastic-mushroom-01', 'elastic-mushroom');
  actor.addComponent(new TransformComponent({ position: [1, 0, 2], yaw: 0 }));
  actor.addComponent(new ElasticTetherComponent({
    restLength: 0.72,
    breakLength: 1.55,
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
