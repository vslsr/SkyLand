import type * as THREE from 'three';
import type { GrassInteractionTarget } from '../grass';
import type { SnapshotActor } from '../network/protocol';

export interface SceneVisualSystem {
  readonly root: THREE.Object3D;
  update(deltaSeconds: number, elapsedSeconds: number): void;
  beforeRender?(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void;
  dispose?(): void;
}

export interface ActorSnapshotTarget {
  syncSnapshots(snapshots: readonly SnapshotActor[]): void;
}

export interface SceneComposition {
  scene: THREE.Scene;
  visualSystems: SceneVisualSystem[];
  grassInteraction?: GrassInteractionTarget;
  actorSnapshotTarget?: ActorSnapshotTarget;
}
