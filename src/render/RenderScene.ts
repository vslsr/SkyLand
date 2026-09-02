import type { ActorSimpleCollision } from '../models/actors/ActorVisualModel';
import type {
  ActorArchetypeDefinition,
  ActorRenderDefinition,
} from '../scenes/data/SceneDefinition';
import type { RenderTransformBuffer } from './RenderTransformBuffer';

/**
 * Game World 与 Render World 之间那条边界（引擎迁移路线图 §2 / 第 1 步）。
 *
 * **硬约束：Render World 里不允许出现指向 Actor 的指针，只能有 id 和自己的
 * 数据副本。** 反过来 Game World 里也不允许出现 `THREE.Object3D`——Actor 手上
 * 只有一个 `ProxyId`，实体永远留在拥有它的那一侧。
 *
 * 这条约束现在（单线程、还用着 Three.js）就靠类型强制。它成立与否，是「以后
 * 能不能把渲染搬进 worker」的唯一决定性因素：对象过不了线程边界，只有
 * `SharedArrayBuffer` 里的字节能过。
 *
 * §4.5 把这条边界的数据模型收窄成固定四类，而**不是**通用可变长 primitive 表：
 *
 * ```text
 * RenderWorld
 * ├ TerrainField       每 chunk 一张 code 纹理 + 高度层偏移   （仍在 ChunkStreamer 里）
 * ├ PropInstances[4]   tree / grass / rock / mushroom       （仍在 ChunkStreamer 里）
 * ├ WaterField         水面格实例                            （仍在 ChunkStreamer 里）
 * └ Meshes[]           玩家、Actor、交互标记等一次性网格      ← 第 1 步只搬这一类
 * ```
 *
 * 定长数组而不是逐对象分配，是「跨线程传的就是几段 Float32Array 视图」这件事
 * 能成立的原因。所以这个接口刻意**不**提供通用的 `createProxy(desc)`：新增一类
 * 内容要新增一个具名入口，而不是往一张可变长表里再塞一种 kind。
 */

/**
 * 渲染世界里一个 primitive 的稳定标识，同时是它在 transform SoA 里的槽位下标。
 * 跨线程只传它。
 */
export type ProxyId = number & { readonly __renderProxy: unique symbol };

export const NULL_PROXY_ID = -1 as ProxyId;

export function toProxyId(slot: number): ProxyId {
  return slot as ProxyId;
}

/** 建一个 Actor 网格 proxy 需要的全部信息——是配置描述，不是 Object3D。 */
export interface MeshProxyDesc {
  /** 调试用名字，会写到渲染侧对象上。 */
  readonly name: string;
  /**
   * 程序化模型的配置。渲染世界自己把它变成几何，Game World 不碰几何。
   * 省略时得到一对空的 root / visualRoot，供纯挂载用途的 Actor 使用。
   */
  readonly render?: ActorRenderDefinition;
  /**
   * 这个 proxy 要不要交互标记 / 温度牌。
   *
   * 「要不要」是 spawn 时的一次性事实，所以走 desc 而不是每帧的参数段；
   * 锚点不在这里——它们由模型自己产出，本来就在渲染侧（见 MeshProxyInfo）。
   */
  readonly interactionMarker?: boolean;
  readonly temperatureMarker?: boolean;
  /**
   * 引导路径的样式。**样式不在快照里**——它来自已净化的 Actor 原型
   * （见 `GuidePathComponent.mjs` 的注释），所以照 `render` 的先例在这里一次性
   * 给定；每帧过边界的只有路点、当前节点与开关。
   */
  readonly guidePath?: GuidePathStyle;
}

export interface GuidePathStyle {
  readonly lineColor: string;
  readonly markerColor: string;
  readonly lineWidth: number;
  readonly dashLength: number;
  readonly gapLength: number;
  readonly dashSpeed: number;
  readonly markerSize: number;
}

/**
 * 玩家史莱姆的渲染定义。本地玩家与远端玩家都用它，普通 Actor 也可以。
 */
export type PlayerRenderDefinition = Extract<
  ActorRenderDefinition,
  { model: 'line-art-player-slime' | 'line-art-pbf-slime' }
>;

export type SlimeSurfaceDragDefinition = NonNullable<
  ActorArchetypeDefinition['components']['slimeSurfaceDrag']
>;

/**
 * 玩家 proxy 的 spawn 期事实。
 *
 * 玩家有自己的入口而不是复用 `createMeshProxy`，是 §4.5 那条取向的直接应用：
 * 玩家是另一类内容（自带配色、走路动画与蒙皮拖拽），新增一类内容就新增一个
 * 具名入口，而不是往 `MeshProxyDesc` 上挂几个只有玩家会用的可选字段。
 */
export interface PlayerProxyDesc {
  readonly name: string;
  readonly render: PlayerRenderDefinition;
  /**
   * 配色种子。给了就按它取一套区分色（远端玩家用自己的 id），
   * 不给就是本地玩家那套默认配色。
   *
   * 过边界的是**身份**不是颜色：哪种身份配哪套颜色是渲染侧的决定。
   */
  readonly paletteSeed?: string;
  /** `line-art-player-slime` 的走路动画参考速度。 */
  readonly walkSpeed: number;
  /** 蒙皮拖拽参数；省略时渲染侧按半径推一套等价默认值。 */
  readonly surfaceDrag?: SlimeSurfaceDragDefinition;
}

/** 一条世界射线。指针与相机都在渲染这一侧，所以它不跨边界，只在渲染世界内部走。 */
export interface SlimeSurfaceDragRay {
  readonly origin: readonly [number, number, number];
  readonly direction: readonly [number, number, number];
}

/**
 * `createMeshProxy` 回给 Game World 的东西：**全是数值，没有一个 Object3D**。
 * 这些量本身是玩法数据（碰撞盒、船体长宽），只是恰好和模型 authoring 同时产出。
 */
export interface MeshProxyInfo {
  readonly id: ProxyId;
  readonly length: number;
  readonly width: number;
  readonly interactionAnchorY: number;
  readonly simpleCollision: ActorSimpleCollision;
}

/**
 * Game World 往 Render World 发的命令。
 *
 * 单线程下它是一次直接调用；上 worker 之后同一个方法变成「往环形缓冲写一条
 * destroy 命令」。持有这个接口的 Component 因此只持有一个命令口，不持有场景。
 */
export interface RenderCommandSink {
  destroyMeshProxy(id: ProxyId): void;
}

export interface RenderScene extends RenderCommandSink {
  createMeshProxy(desc: MeshProxyDesc): MeshProxyInfo;
  /** 玩家史莱姆。见 `PlayerProxyDesc`：另一类内容，另一个具名入口。 */
  createPlayerProxy(desc: PlayerProxyDesc): MeshProxyInfo;
  /**
   * 把这一帧的 transform SoA 兑现到渲染世界。
   *
   * 参数是**字节**，不是 `Object3D`——这正是 §2 里那条「边界上只能放数据」的
   * 落地形式。上 worker 之后调用方变成渲染线程，实现不变。
   */
  submitTransforms(transforms: RenderTransformBuffer): void;
}
