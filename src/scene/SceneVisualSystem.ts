import type { ContainerModelLike } from '../inventory/index';
import type * as THREE from 'three';
import type { Actor } from '../../shared/actor/Actor.mjs';
import type { CollisionWorld } from '../../shared/collision/index.mjs';
import type { DayNightVisualTarget } from '../environment/EnvironmentTypes';
import type { SceneEnvironmentRuntime } from '../materials/createFillMaterial';
import type { GrassInteractionTarget } from '../grass';
import type { ThreeMeshProxy } from '../render/three/ThreeMeshProxy';
import type { ThreeRenderScene } from '../render/three/ThreeRenderScene';
import type { RenderTransformBuffer } from '../render/RenderTransformBuffer';
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
}

export interface SceneVisualSystem {
  readonly root: THREE.Object3D;
  update(deltaSeconds: number, elapsedSeconds: number, context?: SceneUpdateContext): void;
  beforeRender?(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void;
  /** 场景被换掉时释放这个系统独占的资源。 */
  dispose?(): void;
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
  /**
   * 按 Actor id 取渲染世界里的 proxy。Actor 上只有 proxyId，Object3D 住在渲染侧，
   * 所以还留在客户端的表现代码（能力实验室的目标 rig）经由这里查。
   */
  getActorRenderProxy(actorId: string): ThreeMeshProxy | undefined;
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
  /** 这个 Actor 上的容器状态；界面据此画箱内内容。 */
  getContainer?(actorId: string): ContainerModelLike | undefined;
  /** 服务端认为我正开着哪个容器；开合不是本地状态，见 ContainerController。 */
  findOpenContainerActorId?(): string | undefined;
  setHoveredActorId(actorId?: string): void;
  setInteractionMarkerActorId(actorId?: string, inputLabel?: string, opacity?: number): void;
  getVesselHudState(playerId: string): VesselHudState | undefined;
  /** 把 Actor 当前的碰撞盒登记进场景碰撞世界。查询前调用，每帧最多兑现一次。 */
  refreshColliders(): void;
  setSimpleCollisionVisible(visible: boolean): void;
  setTemperatureVisible(visible: boolean): void;
}

export interface ActorInteractionCandidate {
  actorId: string;
  label: string;
  action: 'cargo-toggle' | 'mushroom-bite' | 'pickup-stack' | 'harvest-prop' | 'container-open';
  carrierActorId: string | null;
  holderPlayerId: string | null;
  pickupHolderActorId: string | null;
  quantity?: number;
  /** 这个容器我开着没有；开着时交互键说的是「关上」。 */
  containerOpen?: boolean;
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

export interface SceneComposition {
  scene: THREE.Scene;
  visualSystems: SceneVisualSystem[];
  weatherTarget?: WeatherVisualTarget;
  dayNightTarget?: DayNightVisualTarget;
  /** 场景级共享光照/雾 uniform；场景 Component 建的表现也接到同一份上。 */
  environmentRuntime?: SceneEnvironmentRuntime;
  grassInteraction?: GrassInteractionTarget;
  actorSnapshotTarget?: ActorSnapshotTarget;
  /**
   * 这张地图的渲染世界与它那段边界字节。
   *
   * 归场景所有，不归 `ClientActorSystem`：本地玩家和远端玩家都不是 Replica，
   * 但它们的 proxy 必须和 Actor 的 proxy 落在同一个渲染世界、同一段 SoA 里，
   * 否则「一个 ProxyId 指一个东西」就不成立了。
   */
  renderScene?: ThreeRenderScene;
  renderTransforms?: RenderTransformBuffer;
  /**
   * 旧 CollisionWorld 只保留给非玩家 Actor 推出、交互宽相与兼容调试。
   * 玩家和相机均使用下面的 Rapier PhysicsWorld。
   */
  collisionWorld?: CollisionWorld;
  /** 规则地形的内容采样（草、水、编辑等）；玩家碰撞由 trimesh 负责。 */
  terrainWorld?: TerrainWorld;
  physicsWorld?: PhysicsWorld;
}
