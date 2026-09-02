import type { ActorSimpleCollision } from '../models/actors/ActorVisualModel';
import type { ActorRenderDefinition } from '../scenes/data/SceneDefinition';
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
  /**
   * 把这一帧的 transform SoA 兑现到渲染世界。
   *
   * 参数是**字节**，不是 `Object3D`——这正是 §2 里那条「边界上只能放数据」的
   * 落地形式。上 worker 之后调用方变成渲染线程，实现不变。
   */
  submitTransforms(transforms: RenderTransformBuffer): void;
}
