import type * as THREE from 'three';
import type { GrassInteractionTarget } from '../grass';
import type { SnapshotActor } from '../network/protocol';

/**
 * 每帧传给场景系统的上下文。
 *
 * 焦点是「世界应该围绕谁展开」：有玩家时是玩家，没有玩家时是相机。
 * 流式加载需要它来决定加载哪些 chunk，其它系统可以忽略。
 */
export interface SceneUpdateContext {
  focusX: number;
  focusZ: number;
}

export interface SceneVisualSystem {
  readonly root: THREE.Object3D;
  update(deltaSeconds: number, elapsedSeconds: number, context?: SceneUpdateContext): void;
  beforeRender?(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void;
  /** 场景被换掉时释放这个系统独占的资源。 */
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
