import * as THREE from 'three';

import { ClientActorSystem, type ClientActorSystemOptions } from '../src/actors/ClientActorSystem';
import {
  RENDER_PROXY_COMPONENT,
  type RenderProxyComponent,
} from '../src/actors/components/RenderProxyComponent';
import { createArchetypeTable } from '../src/render/propInstanceLayout';
import { RenderTransformBuffer } from '../src/render/RenderTransformBuffer';
import type { ThreeMeshProxy } from '../src/render/three/ThreeMeshProxy';
import { ThreeRenderScene } from '../src/render/three/ThreeRenderScene';

/**
 * 测试用的渲染侧探针。
 *
 * `ClientActorSystem` 现在只认识边界接口 `RenderScene`——它既不建后端，也不知道
 * `resolve` 或 `root` 是什么。测试要断言画出来的东西，所以往下转这一步留在这里：
 * **「谁在跨边界拿对象」于是在类型上看得见，只有这个文件。**
 */
export function renderBackendOf(system: ClientActorSystem): ThreeRenderScene {
  return system.getRenderScene() as ThreeRenderScene;
}

/**
 * 单独使用 `ClientActorSystem` 的用例用的装配。
 *
 * 渲染世界是必填项——曾经不传就由 `ClientActorSystem` 自己 `new ThreeRenderScene(...)`
 * 兜底，那是那个文件 import three 的唯一原因。兜底搬到测试这一侧之后，
 * 玩法侧那份代码里再没有 three。
 */
export function createTestActorSystem(
  options: Omit<ClientActorSystemOptions, 'renderScene' | 'transforms'>
    & { transforms?: RenderTransformBuffer },
): ClientActorSystem {
  const root = new THREE.Group();
  root.name = 'replicated-actor-world';
  const transforms = options.transforms ?? new RenderTransformBuffer();
  const system = new ClientActorSystem({
    ...options,
    transforms,
    renderScene: new ThreeRenderScene(
      root,
      options.environment,
      options.definition.renderer.ocean,
      createArchetypeTable(options.definition),
    ),
  });
  frameInputs.set(system, transforms);
  return system;
}

/** `createTestActorSystem` 建的那段字节，`stepActorFrame` 要拿它去跑渲染阶段。 */
const frameInputs = new WeakMap<ClientActorSystem, RenderTransformBuffer>();

/**
 * 跑完整的一帧：先玩法阶段，再渲染阶段。
 *
 * 这两段曾经都在 `ClientActorSystem.update` 里，所以用例调一次 `update` 就够。
 * 渲染那一半搬走之后，「渲染读的是这一 tick 写完的字节」由 `SceneRenderer` 的调用
 * 顺序保证——用例要断言画出来的东西，就得照同一个顺序跑。
 */
export function stepActorFrame(
  system: ClientActorSystem,
  deltaSeconds: number,
  elapsedSeconds = 0,
  context?: Parameters<ClientActorSystem['update']>[2],
): void {
  system.update(deltaSeconds, elapsedSeconds, context);
  const transforms = frameInputs.get(system);
  if (transforms) renderBackendOf(system).updateVisuals(transforms, deltaSeconds, elapsedSeconds);
}

/** 渲染世界的根。用例靠它断言「这个 Actor 画出来了没有」。 */
export function renderRootOf(system: ClientActorSystem): THREE.Group {
  return renderBackendOf(system).root;
}

/** Actor 上只有一个 `proxyId`，实体去渲染世界取——明面上的两步。 */
export function renderProxyOf(
  system: ClientActorSystem,
  actorId: string,
): ThreeMeshProxy | undefined {
  const actor = system.getActor(actorId);
  const proxy = actor?.getComponent(RENDER_PROXY_COMPONENT) as RenderProxyComponent | undefined;
  return proxy ? renderBackendOf(system).resolve(proxy.proxyId) : undefined;
}
