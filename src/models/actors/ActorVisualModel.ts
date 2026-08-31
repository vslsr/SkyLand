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
  /** 仅训练假人提供；能力表现只修改这些 VisualRoot 下的展示节点。 */
  readonly abilityTargetRig?: AbilityTargetVisualRig;
}

export interface ElasticTetherVisualRig {
  readonly elasticRoot: THREE.Group;
  readonly stemRoot: THREE.Group;
  readonly capRoot: THREE.Group;
  readonly restLength: number;
}

export interface AbilityTargetVisualRig {
  readonly targetRoot: THREE.Group;
  readonly core: THREE.Group;
  readonly burningAura: THREE.Group;
  readonly targetPoint: THREE.Object3D;
}
