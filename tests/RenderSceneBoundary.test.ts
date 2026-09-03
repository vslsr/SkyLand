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
import { RenderProxyTable } from '../src/render/RenderProxyTable';
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
  // 槽位由玩法侧分配：渲染世界不回话（见 RenderScene.createMeshProxy）。
  const proxyIds = new RenderProxyTable(scene);
  const transforms = new RenderTransformBuffer(8);
  const world = new ActorWorld();
  world.addSystem(new ActorTransformSystem(transforms));
  world.addSystem(new RenderTransformSyncSystem(transforms, scene));
  return { root, scene, proxyIds, transforms, world };
}

function spawn(
  world: ActorWorld,
  scene: ThreeRenderScene,
  proxyIds: RenderProxyTable,
  id: string,
  transform: { x: number; y: number; z: number; yaw: number },
  render?: ActorRenderDefinition,
): Actor {
  const actor = new Actor(id, 'test-archetype');
  actor.addComponent(new TransformComponent({
    position: [transform.x, transform.y, transform.z],
    yaw: transform.yaw,
  }));
  const proxyId = proxyIds.acquire();
  scene.createMeshProxy(proxyId, { name: `actor-${id}`, render });
  actor.addComponent(new RenderProxyComponent(proxyId, proxyIds));
  world.addActor(actor);
  return actor as Actor;
}

test('Actor 只持有 proxyId，渲染世界不认识 Actor', () => {
  const { scene, proxyIds, world } = createWorld();
  const actor = spawn(world, scene, proxyIds, 'crate-01', { x: 1, y: 0, z: 2, yaw: 0 }, CRATE);
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
  const { root, scene, proxyIds, transforms, world } = createWorld();
  const actor = spawn(world, scene, proxyIds, 'crate-01', { x: 1, y: 0.5, z: 2, yaw: 0.25 }, CRATE);
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
  const { root, scene, proxyIds, world } = createWorld();
  const parent = spawn(world, scene, proxyIds, 'raft', { x: 10, y: 1, z: 0, yaw: Math.PI / 2 }, CRATE);
  const child = spawn(world, scene, proxyIds, 'crate', { x: 10, y: 1.6, z: 2, yaw: Math.PI / 2 }, CRATE);
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
  const { root, scene, proxyIds, world } = createWorld();
  const actor = spawn(world, scene, proxyIds, 'crate-01', { x: 3, y: 0, z: 0, yaw: 0 }, CRATE);
  const firstId = (actor.requireComponent(RENDER_PROXY_COMPONENT) as RenderProxyComponent).proxyId;
  assert.equal(root.children.length, 1);

  world.removeActor(actor.id);
  assert.equal(scene.resolve(firstId), undefined);
  assert.equal(root.children.length, 0);

  const reused = spawn(world, scene, proxyIds, 'crate-02', { x: -4, y: 0, z: 0, yaw: 0 }, CRATE);
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
 * guidance、slime、grass）。下面这份豁免清单**只能变短**，现在它空了：
 * 八项全部搬完，第 2 步的前置条件已经满足。多出一项就说明有人又在 Actor 上
 * 挂了渲染对象。
 */
const COMPONENTS_STILL_IMPORTING_RENDER_MODULES: string[] = [];

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

/**
 * 第 3 步的棘轮（`doc/engine-migration-implementation-plan.md` §3）。
 *
 * **边界必须是单向的**：`RenderScene` 上每一个方法都返回 `void`。
 *
 * 有返回值就意味着调用方要等对面回话，而线程边界上没有「等一下」——
 * `createMeshProxy` 曾经回送槽位号与碰撞盒，那是 canvas 进渲染线程的最后一个
 * 阻塞点。槽位改由 `RenderProxyTable` 在玩法侧分配，碰撞盒改由玩法侧自己按
 * 同一个 shared 纯函数算（见 `RenderProxyCollisionParity.test.ts`）。
 *
 * 这条按源码文本检查而不是按类型：类型上 `void` 与「返回了但没人用」区分不开，
 * 而后者一样会在 worker 上炸。
 */
test('RenderScene 上每一个方法都返回 void——边界是单向的', () => {
  const source = readFileSync(
    new URL('../src/render/RenderScene.ts', import.meta.url),
    'utf8',
  );
  // 只看两个接口体内部的方法签名。
  const bodies = [...source.matchAll(
    /export interface (RenderCommandSink|RenderScene)[^{]*\{([\s\S]*?)\n\}/g,
  )];
  assert.equal(bodies.length, 2, '接口改名了？这条棘轮要跟着改');
  const signatures = bodies.flatMap(([, , body]) => (
    [...body.matchAll(/^\s{2}(\w+)\(([^)]*)\):\s*([^;]+);/gm)]
  ));
  assert.ok(signatures.length >= 5, '没扫到方法签名，正则和源码对不上了');
  for (const [, name, , returnType] of signatures) {
    assert.equal(
      returnType.trim(),
      'void',
      `RenderScene.${name} 有返回值——调用方就得等渲染世界回话，`
      + '而线程边界上没有「等一下」。要回送的东西请另找一条通道。',
    );
  }
});

/**
 * canvas 交给渲染线程之后，渲染栈跑在**没有 `document`、没有 `window`** 的地方。
 * 所以这份清单盯的是「渲染侧还有几处伸手摸 DOM」。
 *
 * 它只能变短。现在只剩一项，而且那一项是对的：`SceneRenderer` 今天就是持有
 * canvas 的那一个，`devicePixelRatio` 会跟着 canvas 一起搬走，不是要清理的债。
 */
const RENDER_FILES_TOUCHING_DOM = ['SceneRenderer.ts'];

const DOM_ACCESS = /\b(document|window)\s*[.[]/;

test('渲染栈里还摸 DOM 的只有已知的那几个', () => {
  const roots = ['../src/rendering/', '../src/render/', '../src/models/', '../src/materials/'];
  const offenders: string[] = [];
  for (const root of roots) {
    const directory = new URL(root, import.meta.url);
    const walk = (folder: URL): void => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          walk(new URL(`${entry.name}/`, folder));
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const source = readFileSync(new URL(entry.name, folder), 'utf8');
        // 注释里提到 document 不算数，只看真正的代码行。
        const code = source
          .split('\n')
          .filter((line) => {
            const trimmed = line.trimStart();
            return !trimmed.startsWith('*') && !trimmed.startsWith('//');
          })
          .join('\n');
        if (DOM_ACCESS.test(code)) offenders.push(entry.name);
      }
    };
    walk(directory);
  }

  assert.deepEqual(
    offenders.sort(),
    [...RENDER_FILES_TOUCHING_DOM].sort(),
    '这份清单只能变短：渲染线程里没有 document，多出一项就是一处以后会崩的地方',
  );
});

/**
 * 第 3 步的棘轮：**场景组件**（`doc/engine-migration-implementation-plan.md` §3）。
 *
 * 这是最后一类还在主线程上握着 `THREE.Object3D` 的东西，形状和第 1.5 步那八个
 * 表现 Component 一模一样——那一轮把清单从 8 磨到 0，这一轮同理。
 *
 * 它们靠 `renderer.addWorldObject(object)` 把自己建的对象塞进场景图。
 * 渲染循环进线程之后那条路就断了：对象过不了线程边界。出路也和上一轮一样——
 * 要么把建模搬进渲染世界、玩法侧只发描述，要么整个组件搬过去。
 *
 * `SceneComponent.ts` 引的是类型（`THREE.Object3D` 出现在 `addWorldObject` 的签名
 * 上），不是实现，所以不在清单里。
 */
const SCENE_COMPONENTS_STILL_HOLDING_THREE = ['InteractiveParticleEffectSceneComponent.ts'];

test('还在主线程建 THREE 对象的场景组件只有已知的那几个', () => {
  const directory = new URL('../src/scene/components/', import.meta.url);
  const offenders = readdirSync(directory)
    .filter((name) => name.endsWith('.ts') && name !== 'SceneComponent.ts')
    .filter((name) => {
      const source = readFileSync(new URL(name, directory), 'utf8');
      const code = source
        .split('\n')
        .filter((line) => {
          const trimmed = line.trimStart();
          return !trimmed.startsWith('*') && !trimmed.startsWith('//');
        })
        .join('\n');
      return /from 'three'/.test(code) || /addWorldObject/.test(code);
    })
    .sort();

  assert.deepEqual(
    offenders,
    [...SCENE_COMPONENTS_STILL_HOLDING_THREE, 'AbilityLabSceneComponent.ts'].sort(),
    '这份清单只能变短：渲染循环进线程之后，addWorldObject 那条路就断了',
  );
});

/**
 * `onBeforeRender` 是渲染侧往主线程递一个活的 `THREE.Camera`。
 *
 * 鼠标拖草曾经靠它反投影；现在它自己按机位、视场角、宽高比构造射线
 * （见 `tests/MouseGrassUnproject.test.ts`，落点和 `THREE.Raycaster` 一致）。
 * 于是这条回调**在 `SceneRenderer` 之外一个调用方都没有了**。
 */
test('没有人再靠 onBeforeRender 借渲染侧的相机', () => {
  const roots = ['../src/scene/', '../src/grass/', '../src/abilities/', '../src/ui/'];
  const offenders: string[] = [];
  for (const root of roots) {
    const walk = (folder: URL): void => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          walk(new URL(`${entry.name}/`, folder));
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const source = readFileSync(new URL(entry.name, folder), 'utf8');
        const code = source
          .split('\n')
          .filter((line) => {
            const trimmed = line.trimStart();
            return !trimmed.startsWith('*') && !trimmed.startsWith('//');
          })
          .join('\n');
        if (/\.onBeforeRender\(/.test(code)) offenders.push(entry.name);
      }
    };
    walk(new URL(root, import.meta.url));
  }
  assert.deepEqual(offenders, [], '要相机就用主线程自己那份机位，别回调进渲染侧借');
});

/**
 * 第 1.75 步的棘轮（`doc/engine-migration-implementation-plan.md` §1.75）。
 *
 * Component 干净了还不够：Actor 世界里跑的 **System** 也得干净，否则第 2 步
 * 一样搬不进 worker。这四个是 `ClientActorSystem` 注册进 `ActorWorld` 的全部
 * System——两个写 SoA、一个发命令、一个翻面，谁都不认识 `THREE`。
 *
 * 名单写死在这里是有意的：新增一个 ActorWorld System 就要在这里登记，
 * 而登记的代价是它必须先通过这条断言。
 */
const ACTOR_WORLD_SYSTEMS = [
  'ActorTransformSystem.ts',
  'ActorVisualParamSystem.ts',
  'ActorInstanceSystem.ts',
  'ActorFruitInstanceSystem.ts',
  'ActorGuidePathSyncSystem.ts',
  'RenderTransformSyncSystem.ts',
];

test('Actor 世界里的 System 一个都不 import 渲染实现', () => {
  const directory = new URL('../src/actors/systems/', import.meta.url);
  for (const name of ACTOR_WORLD_SYSTEMS) {
    const source = readFileSync(new URL(name, directory), 'utf8');
    // 注释里出现 `from 'three'` 这样的字样不算数，只看真正的 import 行。
    const code = source.split('\n').filter((line) => !line.trimStart().startsWith('*')).join('\n');
    assert.doesNotMatch(
      code,
      RENDER_SIDE_IMPORT,
      `${name} 引了渲染实现——Actor 世界里的 System 只能写字节和发命令`,
    );
  }
});

test('这份名单就是 ClientActorSystem 注册进 ActorWorld 的全部 System', () => {
  // 断言两边对得上：漏登记一个，上面那条检查就悄悄放过了它。
  const source = readFileSync(
    new URL('../src/actors/ClientActorSystem.ts', import.meta.url),
    'utf8',
  );
  const registered = Array.from(source.matchAll(/this\.world\.addSystem\(new (\w+)\(/g))
    .map((match) => `${match[1]}.ts`)
    .sort();
  assert.deepEqual(registered, [...ACTOR_WORLD_SYSTEMS].sort());
});

test('装配中途抛出不会泄漏 proxy 槽位', () => {
  // createMeshProxy 占了槽位，但要到 addActor 之后才由 RenderProxyComponent 的
  // 生命周期负责回收。中间任何一步抛出，槽位既不在 freeSlots 里也没有 Actor 持有
  // 它——泄漏一个挂在场景图上的模型。这里直接对着渲染世界复现那个窗口。
  const { root, scene, proxyIds } = createWorld();
  const first = proxyIds.acquire();
  scene.createMeshProxy(first, { name: 'actor-a', render: CRATE });
  assert.equal(root.children.length, 1);
  assert.equal(proxyIds.liveCount, 1);

  // 模拟装配失败：立刻把 proxy 还回去。销毁走槽位表，因为「销毁」和「回收槽位」
  // 是同一件事——只做一半，下一个 Actor 就会拿到一个还挂着模型的槽位。
  proxyIds.destroyMeshProxy(first);
  assert.equal(scene.resolve(first), undefined);
  assert.equal(root.children.length, 0, '失败路径必须把模型从场景图上摘下来');
  assert.equal(proxyIds.liveCount, 0, '槽位也要还回去，否则编号一路涨');

  // 槽位回到自由表，下一个 Actor 拿到同一个下标。
  const second = proxyIds.acquire();
  scene.createMeshProxy(second, { name: 'actor-b', render: CRATE });
  assert.equal(second, first);
});

test('渲染世界的释放不依赖「每个 proxy 都有活着的 Actor」这条不变量', () => {
  const { root, scene, proxyIds } = createWorld();
  scene.createMeshProxy(proxyIds.acquire(), { name: 'actor-a', render: CRATE });
  scene.createMeshProxy(proxyIds.acquire(), { name: 'actor-b', render: CRATE });
  assert.equal(root.children.length, 2);

  scene.dispose();
  assert.equal(root.children.length, 0, 'dispose 之后场景图上不该留下任何 proxy 的模型');
  assert.deepEqual(scene.liveProxies(), []);
});
