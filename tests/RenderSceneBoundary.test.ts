import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as THREE from 'three';
import { Actor } from '../shared/actor/Actor.mjs';
import { ActorWorld } from '../shared/actor/ActorWorld.mjs';
import { TransformComponent } from '../shared/actor/components/TransformComponent.mjs';
import {
  RENDER_PROXY_COMPONENT,
  RenderProxyComponent,
} from '../src/actors/components/RenderProxyComponent';
import { ActorTransformSystem } from '../src/actors/systems/ActorTransformSystem';
import { RenderTransformSyncSystem } from '../src/actors/systems/RenderTransformSyncSystem';
import { RenderTransformBuffer } from '../src/render/RenderTransformBuffer';
import { ThreeRenderScene } from '../src/render/three/ThreeRenderScene';
import type { ActorRenderDefinition } from '../src/scenes/data/SceneDefinition';

const ENVIRONMENT = { fogColor: '#ffffff', fogNear: 20, fogFar: 60 };

const CRATE: ActorRenderDefinition = {
  model: 'line-art-cargo-crate',
  width: 0.8,
  height: 0.6,
  depth: 0.8,
  bodyColor: '#c8b79a',
  strapColor: '#8a6238',
  inkColor: '#171614',
};

function createWorld() {
  const root = new THREE.Group();
  const scene = new ThreeRenderScene(root, ENVIRONMENT);
  const transforms = new RenderTransformBuffer(8);
  const world = new ActorWorld();
  world.addSystem(new ActorTransformSystem(transforms));
  world.addSystem(new RenderTransformSyncSystem(transforms, scene));
  return { root, scene, transforms, world };
}

function spawn(
  world: ActorWorld,
  scene: ThreeRenderScene,
  id: string,
  transform: { x: number; y: number; z: number; yaw: number },
  render?: ActorRenderDefinition,
): Actor {
  const actor = new Actor(id, 'test-archetype');
  actor.addComponent(new TransformComponent({
    position: [transform.x, transform.y, transform.z],
    yaw: transform.yaw,
  }));
  const info = scene.createMeshProxy({ name: `actor-${id}`, render });
  actor.addComponent(new RenderProxyComponent(info.id, scene));
  world.addActor(actor);
  return actor as Actor;
}

test('Actor 只持有 proxyId，渲染世界不认识 Actor', () => {
  const { scene, world } = createWorld();
  const actor = spawn(world, scene, 'crate-01', { x: 1, y: 0, z: 2, yaw: 0 }, CRATE);
  const proxy = actor.requireComponent(RENDER_PROXY_COMPONENT) as RenderProxyComponent;

  // 这是第 1 步的硬约束：Actor 那一侧只剩一个整数。
  assert.equal(typeof proxy.proxyId, 'number');
  for (const component of actor.components.values()) {
    for (const value of Object.values(component as Record<string, unknown>)) {
      assert.ok(
        !(value instanceof THREE.Object3D),
        `${(component as { type: string }).type} 上出现了 Object3D，边界被打穿了`,
      );
    }
  }

  // 反过来，渲染侧那份记录里没有任何指回 Actor 的字段。
  const render = scene.resolve(proxy.proxyId)!;
  for (const value of Object.values(render as unknown as Record<string, unknown>)) {
    assert.ok(!(value instanceof Actor), 'Render World 里出现了指向 Actor 的指针');
  }
});

test('Game World 只写 SoA，位置由渲染世界从字节兑现', () => {
  const { root, scene, transforms, world } = createWorld();
  const actor = spawn(world, scene, 'crate-01', { x: 1, y: 0.5, z: 2, yaw: 0.25 }, CRATE);
  const proxy = actor.requireComponent(RENDER_PROXY_COMPONENT) as RenderProxyComponent;
  const render = scene.resolve(proxy.proxyId)!;

  // 还没跑 System：字节是空的，Object3D 也还在原点。
  assert.equal(render.root.position.x, 0);

  world.update(1 / 60, 0);
  assert.equal(transforms.readTransform(proxy.proxyId, { x: 0, y: 0, z: 0, yaw: 0 }).x, 1);
  assert.ok(Math.abs(render.root.position.x - 1) < 1e-6);
  assert.ok(Math.abs(render.root.position.y - 0.5) < 1e-6);
  assert.ok(Math.abs(render.root.rotation.y - 0.25) < 1e-6);
  assert.equal(render.root.parent, root);
});

test('父子关系只以 parentProxyId 过边界，局部坐标在渲染侧反算', () => {
  const { root, scene, world } = createWorld();
  const parent = spawn(world, scene, 'raft', { x: 10, y: 1, z: 0, yaw: Math.PI / 2 }, CRATE);
  const child = spawn(world, scene, 'crate', { x: 10, y: 1.6, z: 2, yaw: Math.PI / 2 }, CRATE);
  world.setActorParent(child.id, parent.id, { worldPositionStays: true });
  world.update(1 / 60, 0);

  const parentRender = scene.resolve(
    (parent.requireComponent(RENDER_PROXY_COMPONENT) as RenderProxyComponent).proxyId,
  )!;
  const childRender = scene.resolve(
    (child.requireComponent(RENDER_PROXY_COMPONENT) as RenderProxyComponent).proxyId,
  )!;

  assert.equal(childRender.root.parent, parentRender.root);
  // Three 层级组合出的世界坐标必须严格等于权威插值结果。
  parentRender.root.updateWorldMatrix(true, true);
  const world0 = childRender.root.getWorldPosition(new THREE.Vector3());
  assert.ok(Math.abs(world0.x - 10) < 1e-5);
  assert.ok(Math.abs(world0.y - 1.6) < 1e-5);
  assert.ok(Math.abs(world0.z - 2) < 1e-5);

  // 解除挂载后下一帧重新挂回世界根，父节点的 root 不再参与组合。
  world.setActorParent(child.id, undefined, { worldPositionStays: true });
  world.update(1 / 60, 0);
  assert.equal(childRender.root.parent, root);
  assert.ok(Math.abs(childRender.root.position.z - 2) < 1e-5);
});

test('Actor 销毁会回收 proxy，槽位复用不会读到上一个 proxy 的残留', () => {
  const { root, scene, world } = createWorld();
  const actor = spawn(world, scene, 'crate-01', { x: 3, y: 0, z: 0, yaw: 0 }, CRATE);
  const firstId = (actor.requireComponent(RENDER_PROXY_COMPONENT) as RenderProxyComponent).proxyId;
  assert.equal(root.children.length, 1);

  world.removeActor(actor.id);
  assert.equal(scene.resolve(firstId), undefined);
  assert.equal(root.children.length, 0);

  const reused = spawn(world, scene, 'crate-02', { x: -4, y: 0, z: 0, yaw: 0 }, CRATE);
  const secondId = (reused.requireComponent(RENDER_PROXY_COMPONENT) as RenderProxyComponent).proxyId;
  assert.equal(secondId, firstId, '空槽位应当被复用，proxyId 空间不会无限增长');
  world.update(1 / 60, 0);
  assert.ok(Math.abs(scene.resolve(secondId)!.root.position.x + 4) < 1e-6);
});

test('Game→Render 的写入点不再 import three', () => {
  // 路线图第 1 步的验收条件：这个文件是 Game World 唯一往渲染侧写的地方，
  // 它一旦重新碰上 Object3D，「以后能不能上 worker」这件事就又回到原点。
  const source = readFileSync(
    new URL('../src/actors/systems/ActorTransformSystem.ts', import.meta.url),
    'utf8',
  );
  const code = source.split('\n').filter((line) => !line.trimStart().startsWith('*')).join('\n');
  assert.doesNotMatch(code, /from 'three'/);
  assert.doesNotMatch(code, /\.position\.set\(/);
});

/**
 * 第 1.5 步的棘轮（`doc/engine-migration-implementation-plan.md` §1.5）。
 *
 * 第 1 步把 `THREE.Group` 从 `ThreeObjectComponent` 搬进了渲染世界，但客户端
 * 表现 Component 还各自握着自己的 rig。只要还剩一个，Sim Worker 就搬不过去——
 * 对象过不了线程边界。
 *
 * 规则很简单：**Actor Component 不得 import 渲染侧模块**（three、models、
 * guidance、slime、grass）。下面这份是尚未搬完的豁免清单，**只能变短**：
 * 搬完一个就把它划掉；清单空了，第 2 步的前置条件就满足了。多出一项则说明
 * 有人又在 Actor 上挂了渲染对象。
 */
const COMPONENTS_STILL_IMPORTING_RENDER_MODULES = [
  'FireVisualComponent.ts',
  'GrassDisplacementComponent.ts',
  'GuidePathVisualComponent.ts',
  'HybridSlimeVisualComponent.ts',
  'InteractionMarkerComponent.ts',
  'SlimeSurfaceDragComponent.ts',
  'TemperatureMarkerComponent.ts',
];

// 不含 render/：`RenderProxyComponent` 引的是边界本身的类型（ProxyId 与命令口），
// 那正是它该引的。这条规则针对的是渲染**实现**。
const RENDER_SIDE_IMPORT = /from '(three|(\.\.\/)+(models|guidance|slime|grass|materials)\/)/;

test('还在 import 渲染侧模块的 Actor Component 只有已知的那几个', () => {
  const directory = new URL('../src/actors/components/', import.meta.url);
  const offenders = readdirSync(directory)
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => RENDER_SIDE_IMPORT.test(readFileSync(new URL(name, directory), 'utf8')))
    .sort();

  assert.deepEqual(
    offenders,
    COMPONENTS_STILL_IMPORTING_RENDER_MODULES,
    '这份清单只能变短：搬完一个表现 Component 就把它划掉，多出一项说明边界又被打穿了',
  );
});

test('装配中途抛出不会泄漏 proxy 槽位', () => {
  // createMeshProxy 占了槽位，但要到 addActor 之后才由 RenderProxyComponent 的
  // 生命周期负责回收。中间任何一步抛出，槽位既不在 freeSlots 里也没有 Actor 持有
  // 它——泄漏一个挂在场景图上的模型。这里直接对着渲染世界复现那个窗口。
  const { root, scene } = createWorld();
  const first = scene.createMeshProxy({ name: 'actor-a', render: CRATE });
  assert.equal(root.children.length, 1);

  // 模拟装配失败：立刻把 proxy 还回去。
  scene.destroyMeshProxy(first.id);
  assert.equal(scene.resolve(first.id), undefined);
  assert.equal(root.children.length, 0, '失败路径必须把模型从场景图上摘下来');

  // 槽位回到自由表，下一个 Actor 拿到同一个下标，不会一路涨上去。
  const second = scene.createMeshProxy({ name: 'actor-b', render: CRATE });
  assert.equal(second.id, first.id);
});

test('渲染世界的释放不依赖「每个 proxy 都有活着的 Actor」这条不变量', () => {
  const { root, scene } = createWorld();
  scene.createMeshProxy({ name: 'actor-a', render: CRATE });
  scene.createMeshProxy({ name: 'actor-b', render: CRATE });
  assert.equal(root.children.length, 2);

  scene.dispose();
  assert.equal(root.children.length, 0, 'dispose 之后场景图上不该留下任何 proxy 的模型');
  assert.deepEqual(scene.liveProxies(), []);
});
