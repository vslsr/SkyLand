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
   * 锚点不在这里——它们由模型自己产出，本来就在渲染侧，也不回送。
   */
  readonly interactionMarker?: boolean;
  readonly temperatureMarker?: boolean;
  /**
   * 引导路径的样式。**样式不在快照里**——它来自已净化的 Actor 原型
   * （见 `GuidePathComponent.mjs` 的注释），所以照 `render` 的先例在这里一次性
   * 给定；每帧过边界的只有路点、当前节点与开关。
   */
  readonly guidePath?: GuidePathStyle;
  /**
   * 这个 proxy 的 `visualRoot` 由哪种客户端波动驱动。
   *
   * 「是船体还是货箱」来自原型（有 buoyancy 还是有 cargo），是 spawn 时的一次性
   * 事实，所以走 desc；每帧过边界的只有吃水与静态倾斜那三个标量。
   * 没有海的地图上渲染世界会忽略它。
   */
  readonly waterMotion?: 'hull' | 'cargo';
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
 * 引导路径每帧可能变的那部分。**变长**，所以它走命令而不是参数段。
 *
 * 路径与索引装在同一条命令里：`GuidePath.setPath` 内部会 `reset()` 把进度归零，
 * 拆成两条、中间隔一帧的话，玩家会看到引导线闪回起点再跳回去。
 */
export interface GuidePathState {
  readonly points: readonly (readonly [number, number, number])[];
  readonly curve: 'linear' | 'catmull-rom';
  readonly markerColor: string;
  readonly currentPointIndex: number;
  readonly enabled: boolean;
}

/**
 * Game World 往 Render World 发的命令。
 *
 * 单线程下它是一次直接调用；上 worker 之后同一个方法变成「往环形缓冲写一条
 * 命令」。持有这个接口的 System 因此只持有一个命令口，不持有场景。
 */
export interface RenderCommandSink {
  destroyMeshProxy(id: ProxyId): void;
  /**
   * 应用一次引导路径状态。`pathChanged` 由玩法侧按 pathRevision 判断——
   * 「要不要重铺路径」是发送方的事实，渲染侧只负责应用。
   */
  setGuidePath(id: ProxyId, state: GuidePathState, pathChanged: boolean): void;
}

/**
 * 渲染世界的**全部**入口。
 *
 * 「全部」是有意义的：玩法侧只准通过这个接口说话。够到具体后端（`ThreeRenderScene`）
 * 就绕过了那条「每个方法返回 void」的棘轮——而那条棘轮是 canvas 能不能进线程的
 * 唯一保障。
 *
 * 两个**没有**列在这里的方法：`faceCameras(THREE.Camera)` 与
 * `setGuidePathResolution(w, h)`。它们收的是 Three 的相机和画布尺寸，是渲染世界
 * **内部**的每帧动作，只是眼下经由 `ClientActorSystem.beforeRender` 路过——
 * 渲染循环进线程之后它们跟着走，不会出现在边界上。
 */
export interface RenderScene extends RenderCommandSink {
  /**
   * 在指定槽位建一个 Actor 网格 proxy。
   *
   * **槽位号由调用方给，这里不回话**——返回值是 canvas 进渲染线程的阻塞点，
   * 函数调用要等对面，而线程边界上没有「等一下」。分配在
   * `RenderProxyTable`（Game World 那一侧）。
   *
   * 这里原来还回送碰撞盒与模型尺寸。尺寸玩法侧一次都没读过；碰撞盒是一次纯粹的
   * 往返——渲染侧算它的方式就是调 `createSimpleCollisionFromRender(render)`，
   * 一个输入只有 render 定义的 shared 纯函数。见
   * `tests/RenderProxyCollisionParity.test.ts`。
   */
  createMeshProxy(id: ProxyId, desc: MeshProxyDesc): void;
  /** 玩家史莱姆。见 `PlayerProxyDesc`：另一类内容，另一个具名入口。 */
  createPlayerProxy(id: ProxyId, desc: PlayerProxyDesc): void;
  /**
   * 准星选中了谁 / 悬停高亮谁。`NULL_PROXY_ID` 表示没有。
   *
   * 标记牌与高亮盒整个在渲染世界里建与释放，玩法侧只说「是哪一个」——
   * 没有 proxy 的 Actor（生成物件、合批掉落物）和「没有选中」是同一种输入。
   */
  setInteractionMarker(id: ProxyId, label: string): void;
  setHoveredProxy(id: ProxyId): void;
  /** 两个调试开关。它们是渲染世界自己的状态，不在 Actor 上镜像。 */
  setTemperatureMarkersVisible(visible: boolean): void;
  setSimpleCollisionVisible(visible: boolean): void;
  /** 渲染世界自己的表现系统跑一帧。读的是刚翻面的那一段字节。 */
  updateVisuals(
    transforms: RenderTransformBuffer,
    deltaSeconds: number,
    elapsedSeconds: number,
  ): void;
  dispose(): void;
  /**
   * 把这一帧的 transform SoA 兑现到渲染世界。
   *
   * 参数是**字节**，不是 `Object3D`——这正是 §2 里那条「边界上只能放数据」的
   * 落地形式。上 worker 之后调用方变成渲染线程，实现不变。
   */
  submitTransforms(transforms: RenderTransformBuffer): void;
}
