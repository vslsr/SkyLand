import { ActorComponent } from '../../../shared/actor/ActorComponent.mjs';
import type {
  InteractiveParticleEffect,
  InteractiveParticleImpulse,
} from '../../particles/InteractiveParticleEffect';

export const INTERACTIVE_PARTICLE_EFFECT_COMPONENT = 'interactive-particle-effect';

/** 客户端表现 Component：拥有一套有界粒子模拟及其 Three.js 资源。 */
export class InteractiveParticleEffectComponent extends ActorComponent {
  private disposed = false;

  public constructor(public readonly effect: InteractiveParticleEffect) {
    super(INTERACTIVE_PARTICLE_EFFECT_COMPONENT);
  }

  public update(deltaSeconds: number, elapsedSeconds: number): void {
    if (!this.disposed) this.effect.update(deltaSeconds, elapsedSeconds);
  }

  public applyWorldImpulse(impulse: InteractiveParticleImpulse): number {
    return this.disposed ? 0 : this.effect.applyWorldImpulse(impulse);
  }

  public refreshSurfaceHeights(): void {
    if (!this.disposed) this.effect.refreshSurfaceHeights?.();
  }

  public override onEndPlay(): void {
    this.disposeEffect();
  }

  public override onDetach(): void {
    this.disposeEffect();
  }

  private disposeEffect(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.effect.dispose();
  }
}
