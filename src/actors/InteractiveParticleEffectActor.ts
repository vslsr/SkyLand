import type * as THREE from 'three';
import { Actor } from '../../shared/actor/Actor.mjs';
import type {
  InteractiveParticleEffect,
  InteractiveParticleImpulse,
} from '../particles/InteractiveParticleEffect';
import {
  InteractiveParticleEffectComponent,
} from './components/InteractiveParticleEffectComponent';

/**
 * 一个 Actor 管理一整组实例化粒子。粒子不是子 Actor，容量和生命周期均由效果实现限定。
 */
export class InteractiveParticleEffectActor extends Actor {
  public readonly particleEffect: InteractiveParticleEffectComponent;

  public constructor(id: string, effect: InteractiveParticleEffect) {
    super(id, 'client-interactive-particle-effect');
    this.particleEffect = this.addComponent(
      new InteractiveParticleEffectComponent(effect),
    ) as InteractiveParticleEffectComponent;
  }

  public get object3D(): THREE.Object3D {
    return this.particleEffect.effect.root;
  }

  public applyWorldImpulse(impulse: InteractiveParticleImpulse): number {
    return this.particleEffect.applyWorldImpulse(impulse);
  }

  /** 地形改写后让这一团粒子重新贴回地表。 */
  public refreshSurfaceHeights(): void {
    this.particleEffect.refreshSurfaceHeights();
  }
}
