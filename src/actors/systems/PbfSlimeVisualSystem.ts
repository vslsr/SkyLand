import type { Actor, ActorWorld } from '../../../shared/actor/index.mjs';
import {
  PBF_SLIME_VISUAL_COMPONENT,
  type PbfSlimeVisualComponent,
} from '../components/PbfSlimeVisualComponent';
import {
  THREE_OBJECT_COMPONENT,
  type ThreeObjectComponent,
} from '../components/ThreeObjectComponent';

/** 固定粒子预算的客户端软泥表现；服务端和其他客户端无需复制粒子。 */
export class PbfSlimeVisualSystem {
  public update(world: ActorWorld, deltaSeconds: number, elapsedSeconds: number): void {
    for (const actor of world.query(PBF_SLIME_VISUAL_COMPONENT) as Actor[]) {
      const slime = actor.requireComponent(
        PBF_SLIME_VISUAL_COMPONENT,
      ) as PbfSlimeVisualComponent;
      const render = actor.requireComponent(THREE_OBJECT_COMPONENT) as ThreeObjectComponent;
      slime.update(deltaSeconds, elapsedSeconds, {
        authorityYaw: render.root.rotation.y,
        movementSpeed: 0,
      });
    }
  }
}
