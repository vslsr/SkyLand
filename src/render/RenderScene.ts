import type {
  AbilityLabAction,
  AbilityLabViewState,
} from '../abilities/lab/AbilityLabSimulation';
import type {
  ActorArchetypeDefinition,
  ActorRenderDefinition,
} from '../scenes/data/SceneDefinition';
import type { PointLightDesc } from './RenderPointLights';
import type { RenderInstanceBuffer } from './RenderInstanceBuffer';
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
  /**
   * 这个 proxy 要不要点亮周围，以及那盏灯长什么样。
   *
   * 颜色、半径、闪烁幅度都是**建立时的一次性事实**（来自 Actor 原型的
   * `pointLight` 配置），所以照 `render` 的先例走这里；每帧过边界的只有
   * 「亮不亮」那一个标量（`PARAM_POINT_LIGHT_INTENSITY`）。
   *
   * 光心位置也不在这里：它就是这个 proxy 的世界坐标抬高 `heightOffset`，
   * 而世界坐标每帧本来就在 transform SoA 里，渲染侧自己读得到。
   */
  readonly pointLight?: PointLightDesc;
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
  { model: 'line-art-player-slime' | 'line-art-pbf-slime' | 'line-art-legged-slime' }
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

/**
 * 一条世界射线。指针与相机都在主线程，所以这条射线是从那一侧发过来的：
 * 六个数，结构化克隆过得去。
 */
export interface SlimeSurfaceDragRay {
  readonly origin: readonly [number, number, number];
  readonly direction: readonly [number, number, number];
}

/**
 * 一次拖拽手势本身，全部是 proxy 本地坐标的标量。
 *
 * 射线不跨边界，这个结构却要：玩法侧得把本地玩家的手势发给房间，其他客户端
 * 才能复现同一次形变。过去的是**六个数字**，不是外壳的四百多个顶点——接收端
 * 用自己那套参数在自己的求解器上重放。
 */
export interface SlimeSurfaceDragState {
  contactX: number;
  contactY: number;
  contactZ: number;
  pullX: number;
  pullY: number;
  pullZ: number;
}

/**
 * 渲染世界回报「哪个 proxy 的蒙皮正被拖着，拖成什么样」。
 *
 * 这是**边界上仅有的两条反向通知之一**（另一条是 `ChunkViewSink.onGeneratorReady`）。
 * 它存在的理由很具体：抓没抓住外壳、抓在哪一点，判据只有渲染侧有——命中测试打的是
 * 每帧被求解器改写的软体网格。玩法侧发命令，渲染侧回报事实，两边都不用等对方。
 *
 * 手势本身（六个本地坐标）也走这条回报，而不是让玩法侧回头去读：那是一次跨线程
 * 阻塞查询，正是这条边界不做的事。玩法侧把最后一次回报缓存下来，上报房间时读缓存。
 */
export interface SlimeSurfaceDragReport extends SlimeSurfaceDragState {
  readonly id: ProxyId;
  readonly dragging: boolean;
}

export type SlimeSurfaceDragListener = (report: SlimeSurfaceDragReport) => void;

/**
 * 建造幽灵：玩家正要放的那一件，吸附到网格上、按能不能放染成两种颜色。
 *
 * 它不是 proxy——没有 Actor、没有槽位，和悬停高亮盒一样是纯粹的选择辅助。
 * 建造模式下每帧一条命令（和 `setFrameContext` 一个节奏）；渲染侧按 `pieceId`
 * 缓存模型，只有换件时才重建，位姿与红绿每帧改。`render` 是原型里那份配置，
 * 幽灵用和真件同一个工厂建，所以放下去之后长得一模一样。
 */
export interface BuildPreviewState {
  readonly pieceId: string;
  readonly render: ActorRenderDefinition;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly valid: boolean;
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
 * 蓄力时那条白色抛物线（设计稿 `@w` 的 `A`）。
 *
 * **它是表现，不是判定**：真正的判定跟着射出去那支箭走（`ProjectileComponent`），
 * 这条线画的是同一条弧，好让玩家在松手之前看得见这一箭会往哪儿去。弧顶抬多高由
 * 蓄力比例决定，那段插值在渲染侧算——玩法侧只给两个端点、一个比例和一个截断处。
 */
export interface BallisticPreviewState {
  readonly originX: number;
  readonly originY: number;
  readonly originZ: number;
  readonly impactX: number;
  readonly impactY: number;
  readonly impactZ: number;
  /** 蓄力比例 [0, 1]。弧顶按它抬，所以拉得越满线越平、越远。 */
  readonly ratio: number;
  /**
   * 这条弧走得到哪儿，[0, 1]；省略等同于 1。
   *
   * 墙、地形、站在半路上的实体会把它截短——玩法侧拿的是**和服务端飞行判定同一份
   * 沿弧扫掠**的结果，所以线停住的地方就是箭会停住的地方。端点仍然是没被挡住时
   * 的那一对：挡住只截短这条曲线，不改变它的形状。
   */
  readonly travel?: number;
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
 * 一个**没有**列在这里的方法：`ThreeRenderScene.beforeRender(renderer, camera)`。
 * 它收的是 Three 的渲染器与相机——引导线宽要 resize 之后的真实画布尺寸，世界 UI
 * 要相机朝向。两个参数都是**渲染循环自己手里的东西**，跨边界发过来毫无意义，
 * 所以它由渲染循环直接驱动，跟着 canvas 一起进线程。
 *
 * 它曾经经由 `ClientActorSystem.beforeRender` 路过一趟，那让一个玩法类拿到了
 * `WebGLRenderer` 与 `Camera`。现在玩法侧没有任何一处碰得到它们。
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
  setInteractionMarker(id: ProxyId, label: string, opacity?: number): void;
  setHoveredProxy(id: ProxyId): void;
  /** 建造幽灵。传 undefined 收起。见 `BuildPreviewState`。 */
  setBuildPreview(state: BuildPreviewState | undefined): void;
  /** 蓄力时那条白色抛物线。传 undefined 收起。见 `BallisticPreviewState`。 */
  setBallisticPreview(state: BallisticPreviewState | undefined): void;
  /**
   * 能力实验室的三条命令（只有开发用的实验室地图会发）。
   *
   * 这三条曾经是玩法侧最后一处**递出活对象**：`AbilityLabSceneComponent` 先
   * `getActorRenderProxy` 拿到活的 `ThreeMeshProxy`，把 `abilityTargetRig` 交给一个
   * 住在主线程的视觉系统。整套动画现在在渲染世界里，玩法侧只说三件事：
   * 绑谁（`NULL_PROXY_ID` 即解绑）、这一帧什么状态、放一次技能。
   *
   * `AbilityLabViewState` 是纯数据（血量、蓝量、冷却、日志），过得了线程边界；
   * 施法者位置拆成三个标量，因为 `Vector3` 是 three 的词汇，边界上不认。
   */
  setAbilityLabTarget(id: ProxyId): void;
  setAbilityLabState(
    state: AbilityLabViewState | undefined,
    casterX: number,
    casterY: number,
    casterZ: number,
  ): void;
  playAbilityLabAction(
    action: AbilityLabAction,
    casterX: number,
    casterY: number,
    casterZ: number,
    succeeded: boolean,
  ): void;
  /**
   * 放一条伤害 / 治疗飘字。`amount` 为负是伤害、为正是治疗。
   *
   * 走命令而不是参数段：它是**一次性事件**，不是每帧状态——参数段回答的是
   * 「这一帧是什么样」，而飘字回答的是「刚刚发生了什么」。飘多高、什么时候淡掉
   * 整个在渲染侧积分，玩法侧不知道也不需要知道。
   *
   * 坐标是世界坐标而不是 proxyId：挨打的可能是一个还没建 proxy 的目标（合批
   * 掉落物、刚出视野的 Replica），而飘字该照飘。
   */
  spawnHealthPopup(x: number, y: number, z: number, amount: number): void;
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
  /**
   * 把这一帧的合批内容兑现到渲染世界。
   *
   * 和 `submitTransforms` 同一个形状、同一个理由：掉落堆与树上果子都是几百上千个
   * 同模型实例，一个一个建 proxy 是纯浪费，所以它们走定长记录的实例通道。
   * 渲染侧据此重建 `InstancedMesh`——**这一侧不知道那是什么**。
   */
  submitInstances(props: RenderInstanceBuffer, fruit: RenderInstanceBuffer): void;
  /**
   * 蒙皮拖拽。射线由主线程按指针与相机算好（六个数），命中测试在渲染侧做。
   *
   * `beginSlimeSurfaceDrag` 曾经返回「抓住了没有」，是这条边界上最后一次
   * 「等对面回话」。现在它返回 `void`，结果经 `setSlimeSurfaceDragListener`
   * 回报——单线程下那条通知同步就发了，上 worker 之后晚一帧到，而按下那一帧
   * 指针还没动过，所以没有可见差别。
   */
  beginSlimeSurfaceDrag(id: ProxyId, ray: SlimeSurfaceDragRay): void;
  updateSlimeSurfaceDrag(id: ProxyId, ray: SlimeSurfaceDragRay): void;
  endSlimeSurfaceDrag(id: ProxyId): void;
  /** 谁来收上面那条反向通知。同一时刻只有一个拖拽控制器，所以是「设一个」。 */
  setSlimeSurfaceDragListener(listener?: SlimeSurfaceDragListener): void;
}
