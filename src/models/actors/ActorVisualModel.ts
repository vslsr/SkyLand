import type * as THREE from 'three';

export interface ActorSimpleCollision {
  readonly shape: 'box' | 'cylinder';
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
  /** 热状态只控制强度；所有顶点与火星对象都位于该 Actor 的 visualRoot 下。 */
  readonly fireVisualRig?: LineArtFireVisualRig;
  /** 单体软泥外壳；当前由球形核心与弹簧蒙皮驱动，旧 PBF 求解器仍独立保留。 */
  readonly pbfSlimeVisualRig?: PbfSlimeVisualRig;
}

export interface PbfSlimeBubbleVisual {
  readonly mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  readonly phase: number;
  readonly particleIndex: number;
}

export interface PbfSlimeVisualRig {
  readonly root: THREE.Group;
  /** 可拾取的连续外壳；鼠标拖拽只命中它，不命中核心、气泡或阴影。 */
  readonly surface: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  readonly surfaceGeometry: THREE.SphereGeometry;
  readonly surfacePosition: THREE.BufferAttribute;
  readonly surfaceDirections: Float32Array;
  /** 球面方向的局部邻域，用于模拟参考密度格的空间模糊。 */
  readonly surfaceNeighbors: readonly Uint16Array[];
  readonly core: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  readonly faceRoot: THREE.Group;
  readonly bubbles: readonly PbfSlimeBubbleVisual[];
  readonly shadowRoot: THREE.Group;
  readonly shadow: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  /** 阴影圆盘的动态顶点；边界逐点复用贴地蒙皮环。 */
  readonly shadowPosition: THREE.BufferAttribute;
  readonly shadowBoundaryVertices: Uint16Array;
  readonly radius: number;
}

export interface WavyFlameVisual {
  readonly line: THREE.LineLoop;
  readonly position: THREE.BufferAttribute;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly height: number;
  readonly width: number;
  readonly phase: number;
  readonly speed: number;
  readonly segments: number;
}

export interface LineArtFireVisualRig {
  readonly root: THREE.Group;
  readonly flames: readonly WavyFlameVisual[];
  readonly sparks: readonly {
    object: THREE.LineSegments;
    phase: number;
    drift: number;
    x: number;
    y: number;
    z: number;
    rise: number;
  }[];
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
