import type * as THREE from 'three';

export interface ParticleWorldPoint {
  x: number;
  y: number;
  z: number;
}

export interface InteractiveParticleImpulse {
  startPosition: ParticleWorldPoint;
  position: ParticleWorldPoint;
  radius: number;
  strength: number;
}

/**
 * 可由客户端 Actor 托管的粒子表现契约。
 *
 * 实现拥有固定容量的本地模拟与渲染资源；网络层只需要在未来同步语义事件，
 * 不应逐粒子复制 Transform。
 */
export interface InteractiveParticleEffect {
  readonly root: THREE.Object3D;
  update(deltaSeconds: number, elapsedSeconds: number): void;
  applyWorldImpulse(impulse: InteractiveParticleImpulse): number;
  dispose(): void;
}
