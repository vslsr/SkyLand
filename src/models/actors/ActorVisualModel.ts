import type * as THREE from 'three';

export interface ActorSimpleCollision {
  readonly centerX: number;
  readonly centerZ: number;
  readonly halfWidth: number;
  readonly halfLength: number;
  readonly minimumY: number;
  readonly maximumY: number;
}

export interface ActorVisualModel {
  readonly root: THREE.Group;
  readonly visualRoot: THREE.Group;
  readonly length: number;
  readonly width: number;
  /** 与模型 authoring 尺寸同时生成，供权威碰撞和开发可视化使用。 */
  readonly simpleCollision: ActorSimpleCollision;
}
