import type * as THREE from 'three';
import type { Actor } from '../../shared/actor/Actor.mjs';
import type { CollisionWorld } from '../../shared/collision/index.mjs';
import type { RenderScene } from '../render/RenderScene';
import type { RenderTransformBuffer } from '../render/RenderTransformBuffer';
import type { RenderProxyTable } from '../render/RenderProxyTable';
import type { SnapshotActor, SnapshotPlayer } from '../network/protocol';
import type { ActorFloatState, ActorEventType } from '../network/protocol';
import type { WeatherType } from '../weather/index';
import type { TerrainWorld } from '../world/TerrainWorld';
import type { PhysicsWorld } from '../../shared/physics/PhysicsWorld.mjs';

/**
 * 每帧传给场景系统的上下文。
 *
 * 焦点是「世界应该围绕谁展开」：有玩家时是玩家，没有玩家时是相机。
 * 流式加载需要它来决定加载哪些 chunk，其它系统可以忽略。
 */
export interface SceneUpdateContext {
  focusX: number;
  /** 角色高度等局部表现可选用；chunk、天气与草地流送只读取 XZ。 */
  focusY?: number;
  focusZ: number;
  /**
   * 玩家这一帧的**渲染位置**（含插值平滑），没有玩家时省略。
   *
   * 和 focus 不是一回事：focus 的 XZ 取权威位置，流送要的是那个；
   * 而扫过落叶这类表现跟的是眼睛看到的身影，差的那一点正是平滑量。
   * 分成两组而不是复用，是因为它们真的是两个东西。
   */
  playerRenderX?: number;
  playerRenderY?: number;
  playerRenderZ?: number;
}

/**
 * 每帧要被驱动的东西。**渲染器只需要这三样**——它从不碰 `root`。
 *
 * 和 `SceneVisualSystem` 分开，是因为流送规划、Actor 世界这类东西也要每帧被驱动，
 * 但它们不往场景图里挂任何几何。以前它们为了进这张表得凭空长出一个 `root`，
 * 那个字段除了骗过类型检查没有别的用处（实现路径文档 §3）。
 */
export interface SceneFrameSystem {
  update(deltaSeconds: number, elapsedSeconds: number, context?: SceneUpdateContext): void;
  beforeRender?(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void;
  /** 场景被换掉时释放这个系统独占的资源。 */
  dispose?(): void;
}

/** 还往场景图里挂几何的那些。装配时 `scene.add(root)`。 */
export interface SceneVisualSystem extends SceneFrameSystem {
  readonly root: THREE.Object3D;
}

export interface WeatherVisualTarget {
  readonly weather: WeatherType;
  setWeather(weather: WeatherType): void;
}

export interface ActorSnapshotTarget {
  syncSnapshots(
    snapshots: readonly SnapshotActor[],
    serverTime: number,
    receivedAt?: number,
    externalActors?: readonly SnapshotPlayer[],
  ): void;
  getActor(actorId: string): Actor | undefined;
  findOwnedActorId(playerId: string): string | undefined;
  findControllableActorId(): string | undefined;
  pickInteractableActor(
    origin: readonly [number, number, number],
    direction: readonly [number, number, number],
    maximumDistance?: number,
  ): ActorInteractionCandidate | undefined;
  findNearbyInteractableActor(
    position: { x: number; z: number },
  ): ActorInteractionCandidate | undefined;
  /** 这名玩家正拉着或叼着的那一株；它不靠就近搜索，交互键要能直接指向它。 */
  findHeldInteractableActor(playerId: string): ActorInteractionCandidate | undefined;
  setHoveredActorId(actorId?: string): void;
  setInteractionMarkerActorId(actorId?: string, inputLabel?: string): void;
  getVesselHudState(playerId: string): VesselHudState | undefined;
  /** 把 Actor 当前的碰撞盒登记进场景碰撞世界。查询前调用，每帧最多兑现一次。 */
  refreshColliders(): void;
  setSimpleCollisionVisible(visible: boolean): void;
  setTemperatureVisible(visible: boolean): void;
}

export interface ActorInteractionCandidate {
  actorId: string;
  label: string;
  action: 'cargo-toggle' | 'mushroom-bite' | 'pickup-stack' | 'harvest-prop';
  carrierActorId: string | null;
  holderPlayerId: string | null;
  pickupHolderActorId: string | null;
  quantity?: number;
}

export interface VesselHudState {
  actorId: string;
  speed: number;
  cargoMass: number;
  damagedPartCount: number;
  floatState: ActorFloatState;
  eventRevision: number;
  lastEvent: { type: ActorEventType; targetId: string } | null;
}

/**
 * 一张地图的**玩法那一半**（`createGameWorld` 的产物）。
 *
 * 这里曾经也装着渲染那一半（`THREE.Scene`、天气与昼夜的目标、草地写入口、
 * 表现系统）。渲染循环搬进 worker 之后那些东西根本到不了这一侧——它们由
 * `RenderWorldRuntime` 在画布那一边自己建，玩法侧只经由命令口说话。
 */
export interface SceneComposition {
  /** 玩法侧的每帧系统（流送规划、Actor 世界），按更新顺序排好。 */
  visualSystems: SceneFrameSystem[];
  actorSnapshotTarget?: ActorSnapshotTarget;
  /**
   * 这张地图的渲染世界与它那段边界字节。
   *
   * 归场景所有，不归 `ClientActorSystem`：本地玩家和远端玩家都不是 Replica，
   * 但它们的 proxy 必须和 Actor 的 proxy 落在同一个渲染世界、同一段 SoA 里，
   * 否则「一个 ProxyId 指一个东西」就不成立了。
   */
  renderScene?: RenderScene;
  renderTransforms?: RenderTransformBuffer;
  /** 槽位表在玩法侧；玩家实体要和 Actor 共用同一张。 */
  renderProxyIds?: RenderProxyTable;
  /**
   * 旧 CollisionWorld 只保留给非玩家 Actor 推出、交互宽相与兼容调试。
   * 玩家和相机均使用下面的 Rapier PhysicsWorld。
   */
  collisionWorld?: CollisionWorld;
  /** 规则地形的内容采样（草、水、编辑等）；玩家碰撞由 trimesh 负责。 */
  terrainWorld?: TerrainWorld;
  physicsWorld?: PhysicsWorld;
}
