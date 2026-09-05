import type * as THREE from 'three';
import type { ContactShadowMaterial } from '../../materials/createContactShadowMaterial';
import type { SlimeSoftBody } from '../slimeSoftBody';

export interface ActorSimpleCollision {
  readonly shape: 'box' | 'cylinder';
  readonly centerX: number;
  readonly centerZ: number;
  readonly halfWidth: number;
  readonly halfLength: number;
  readonly minimumY: number;
  readonly maximumY: number;
  readonly supportShape: 'box' | 'cylinder';
  readonly supportHalfWidth: number;
  readonly supportHalfLength: number;
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
  /** 仅容器提供；盖子的翻起由渲染侧按开合目标积分。 */
  readonly containerLidRig?: ContainerLidVisualRig;
  /** 脱落成自由物体后绕刚体球心翻滚的枢轴；影子等贴地元素不挂在下面。 */
  readonly dropRollRig?: DropRollVisualRig;
  /** 仅训练假人提供；能力表现只修改这些 VisualRoot 下的展示节点。 */
  readonly abilityTargetRig?: AbilityTargetVisualRig;
  /** 仅弹药提供；俯仰由渲染侧按这一帧的位移求出来，见 `ThreeProjectileVisual`。 */
  readonly projectileRig?: ProjectileVisualRig;
  /** 热状态只控制强度；所有顶点与火星对象都位于该 Actor 的 visualRoot 下。 */
  readonly fireVisualRig?: LineArtFireVisualRig;
  /** 单体软泥外壳；当前由球形核心与弹簧蒙皮驱动，旧 PBF 求解器仍独立保留。 */
  readonly pbfSlimeVisualRig?: PbfSlimeVisualRig;
  /** 由骨骼腿撑起来的软体史莱姆；步态与 IK 由 `ThreeSlimeLegVisual` 驱动。 */
  readonly slimeLegVisualRig?: SlimeLegVisualRig;
}

/** 一条腿的全部节点。两节骨头是圆柱——WebGL 忽略 `LineBasicMaterial.linewidth`。 */
export interface SlimeLegBoneVisual {
  /** 大腿：从髋点指向膝盖。几何沿 +Y 从 0 长到 1，缩放 Y 就是骨长。 */
  readonly thigh: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  /** 小腿：从膝盖指向落脚点。 */
  readonly shin: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  /**
   * 脚：从踝点朝正前方折出去的第三节骨头。
   *
   * 膝盖没有单独的节点——两节骨头之间的夹角本身就是那个关节，再画一个环只会让
   * 线稿多一处噪点。
   */
  readonly foot: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  /** 落脚点那枚灰色贴地椭圆。抬腿时变淡缩小，是接触提示而不是光照阴影。 */
  readonly shadow: THREE.Mesh<THREE.CircleGeometry, ContactShadowMaterial>;
  /** 髋点在身体局部空间的偏移（+Z 是朝向）。 */
  readonly hipLocalX: number;
  readonly hipLocalZ: number;
  /** 步序偏置，0..1 且左右对称；决定起步时各条腿岔开多少。 */
  readonly phase: number;
}

export interface SlimeLegVisualRig {
  /** 身体挂点，被腿抬到髋高；软体在它下面原地挤压。 */
  readonly bodyRoot: THREE.Group;
  /**
   * 骨骼与落脚点的挂点。
   *
   * 它**不跟着身体摇晃**：脚踩在世界的地面上，不该跟着软体的挤压一起上下浮动。
   * 里面的坐标是 proxy 权威 root 的局部空间，因此把世界落脚点换算进来只需要
   * 减去 Actor 的世界坐标再按权威 yaw 反转一次。
   */
  readonly legRoot: THREE.Group;
  readonly softBody: SlimeSoftBody;
  readonly legs: readonly SlimeLegBoneVisual[];
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
  readonly shadow: THREE.Mesh<THREE.CircleGeometry, ContactShadowMaterial>;
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

/**
 * 翻滚枢轴。刚体是一颗球心在 Actor 原点上方 radius 处的球，模型却是以脚底
 * 为原点建的：pivotRoot 抬到球心、bodyRoot 再压回去，旋转就发生在球心上，
 * 而不是把整株蘑菇绕着菌柄根部甩出去。
 */
export interface DropRollVisualRig {
  readonly pivotRoot: THREE.Group;
  readonly bodyRoot: THREE.Group;
}

/**
 * 弹药的俯仰枢轴。
 *
 * 只有 `rotation.x` 归它：水平朝向来自权威 Transform 的 yaw（模型沿 +Z 躺着，
 * 和世界的 yaw=0 是同一个方向），抬头低头则是渲染侧从连续两帧的位移里求出来的
 * 切线——那是表现，不是权威状态，所以它不过网、也不写在 root 上。
 */
export interface ProjectileVisualRig {
  readonly pitchRoot: THREE.Group;
}

/**
 * 箱盖。枢轴在后沿，所以 `lidRoot.rotation.x` 直接就是翻开的角度。
 *
 * `openAngle` 是完全打开时的弧度（负值向后翻）。它属于模型而不是玩法：同一个
 * 容器 Component 换一副外观，盖子该翻多少是新外观自己的事。
 */
export interface ContainerLidVisualRig {
  readonly lidRoot: THREE.Group;
  readonly openAngle: number;
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
