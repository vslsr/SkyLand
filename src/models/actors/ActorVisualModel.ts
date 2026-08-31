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
  /** 世界交互标记挂在权威根节点上的高度，不继承视觉拉伸。 */
  readonly interactionAnchorY?: number;
  /** 仅弹性模型提供；Actor 视觉 System 通过它驱动局部软体表现。 */
  readonly elasticTetherRig?: ElasticTetherVisualRig;
}

export interface ElasticTetherVisualRig {
  readonly elasticRoot: THREE.Group;
  readonly stemRoot: THREE.Group;
  readonly capRoot: THREE.Group;
  readonly restLength: number;
}
