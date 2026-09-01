import type * as THREE from 'three';
import type { Actor } from '../../shared/actor/Actor.mjs';
import type { CollisionWorld } from '../../shared/collision/index.mjs';
import type { GrassInteractionTarget } from '../grass';
import type { SnapshotActor } from '../network/protocol';
import type { ActorFloatState, ActorEventType } from '../network/protocol';
import type { WeatherType } from '../weather/index';
import type { TerrainWorld } from '../world/TerrainWorld';

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
  syncSnapshots(snapshots: readonly SnapshotActor[], serverTime: number, receivedAt?: number): void;
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

export interface SceneComposition {
  scene: THREE.Scene;
  visualSystems: SceneVisualSystem[];
  weatherTarget?: WeatherVisualTarget;
  grassInteraction?: GrassInteractionTarget;
  actorSnapshotTarget?: ActorSnapshotTarget;
  /**
   * 这个场景的碰撞世界：流式 chunk 的静态物件与 Actor 的碰撞盒都登记在这里。
   * 玩家推出与第三人称相机悬臂共用它，随场景一起创建与丢弃。
   */
  collisionWorld?: CollisionWorld;
  /** 规则地形保持为纯函数查询，不向碰撞网格注册 256 个格子。 */
  terrainWorld?: TerrainWorld;
}
