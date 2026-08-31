import type * as THREE from 'three';

export interface SceneVisualSystem {
  readonly root: THREE.Object3D;
  update(deltaSeconds: number, elapsedSeconds: number): void;
}

export interface SceneComposition {
  scene: THREE.Scene;
  visualSystems: SceneVisualSystem[];
}
