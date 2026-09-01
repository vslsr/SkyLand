import type { Actor, ActorWorld } from '../../../shared/actor/index.mjs';
import {
  HYBRID_SLIME_VISUAL_COMPONENT,
  type HybridSlimeVisualComponent,
} from '../components/HybridSlimeVisualComponent';
import {
  THREE_OBJECT_COMPONENT,
  type ThreeObjectComponent,
} from '../components/ThreeObjectComponent';

/** 固定蒙皮顶点预算的客户端混合软体；服务端不模拟或复制弹簧状态。 */
export class HybridSlimeVisualSystem {
  public update(world: ActorWorld, deltaSeconds: number, elapsedSeconds: number): void {
    for (const actor of world.query(HYBRID_SLIME_VISUAL_COMPONENT) as Actor[]) {
      const slime = actor.requireComponent(
        HYBRID_SLIME_VISUAL_COMPONENT,
      ) as HybridSlimeVisualComponent;
      const render = actor.requireComponent(THREE_OBJECT_COMPONENT) as ThreeObjectComponent;
      slime.update(deltaSeconds, elapsedSeconds, {
        authorityYaw: render.root.rotation.y,
        movementSpeed: 0,
      });
    }
  }
}
