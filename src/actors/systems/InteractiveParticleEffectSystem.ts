import type { Actor } from '../../../shared/actor/Actor.mjs';
import type { ActorWorld } from '../../../shared/actor/ActorWorld.mjs';
import {
  INTERACTIVE_PARTICLE_EFFECT_COMPONENT,
  InteractiveParticleEffectComponent,
} from '../components/InteractiveParticleEffectComponent';

/** 更新 ActorWorld 中所有客户端本地交互粒子效果。 */
export class InteractiveParticleEffectSystem {
  public update(world: ActorWorld, deltaSeconds: number, elapsedSeconds: number): void {
    for (const actor of world.query(INTERACTIVE_PARTICLE_EFFECT_COMPONENT) as Actor[]) {
      const component = actor.requireComponent(
        INTERACTIVE_PARTICLE_EFFECT_COMPONENT,
      ) as InteractiveParticleEffectComponent;
      component.update(deltaSeconds, elapsedSeconds);
    }
  }
}
