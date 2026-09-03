import type { ClientActorSystem } from '../src/actors/ClientActorSystem';
import {
  RENDER_PROXY_COMPONENT,
  type RenderProxyComponent,
} from '../src/actors/components/RenderProxyComponent';
import type { ThreeMeshProxy } from '../src/render/three/ThreeMeshProxy';

/**
 * 测试用的渲染侧探针。
 *
 * `ClientActorSystem` 上曾经有个 `getActorRenderProxy(actorId)`，直接把渲染世界里
 * 活的 `ThreeMeshProxy` 递给玩法侧——那是最后一处能从玩法侧摸到 `Object3D` 的门。
 * 玩法代码已经不需要它了，但测试要断言渲染结果，所以这条路留在测试里，而且走的是
 * 明面上的两步：Actor 上只有一个 `proxyId`，实体去渲染世界（`getRenderScene()`）取。
 *
 * 这样一来「谁在跨边界拿对象」在类型上就看得见：只有测试。
 */
export function renderProxyOf(
  system: ClientActorSystem,
  actorId: string,
): ThreeMeshProxy | undefined {
  const actor = system.getActor(actorId);
  const proxy = actor?.getComponent(RENDER_PROXY_COMPONENT) as RenderProxyComponent | undefined;
  return proxy ? system.getRenderScene().resolve(proxy.proxyId) : undefined;
}
