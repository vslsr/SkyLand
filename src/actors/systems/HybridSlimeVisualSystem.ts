import type { Actor, ActorWorld } from '../../../shared/actor/index.mjs';
import {
  HYBRID_SLIME_VISUAL_COMPONENT,
  type HybridSlimeVisualComponent,
} from '../components/HybridSlimeVisualComponent';
import {
  RENDER_PROXY_COMPONENT,
  type RenderProxyComponent,
} from '../components/RenderProxyComponent';
import type { ThreeRenderScene } from '../../render/three/ThreeRenderScene';

/** 固定蒙皮顶点预算的客户端混合软体；服务端不模拟或复制弹簧状态。 */
export class HybridSlimeVisualSystem {
  public constructor(private readonly scene: ThreeRenderScene) {}

  public update(world: ActorWorld, deltaSeconds: number, elapsedSeconds: number): void {
    for (const actor of world.query(HYBRID_SLIME_VISUAL_COMPONENT) as Actor[]) {
      const slime = actor.requireComponent(
        HYBRID_SLIME_VISUAL_COMPONENT,
      ) as HybridSlimeVisualComponent;
      const proxy = actor.requireComponent(RENDER_PROXY_COMPONENT) as RenderProxyComponent;
      const render = this.scene.resolve(proxy.proxyId);
      if (!render) continue;
      slime.update(deltaSeconds, elapsedSeconds, {
        authorityYaw: render.root.rotation.y,
        movementSpeed: 0,
      });
    }
  }
}
