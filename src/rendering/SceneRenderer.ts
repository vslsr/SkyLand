import * as THREE from 'three';
import { TERRAIN_CELL_SIZE } from '../../shared/world/terrainConfig.mjs';
import type { Actor } from '../../shared/actor/Actor.mjs';
import type { CollisionWorld } from '../../shared/collision/index.mjs';
import type { CameraFrame } from '../camera/CameraTransform';
import {
  type GrassBendImpulse,
  type GrassInteractionTarget,
} from '../grass';
import { createLineArtScene } from '../scene/createLineArtScene';
import type { DayNightVisualTarget } from '../environment/EnvironmentTypes';
import type { SceneEnvironmentRuntime } from '../materials/createFillMaterial';
import type {
  ActorInteractionCandidate,
  ActorSnapshotTarget,
  SceneComposition,
  SceneUpdateContext,
  SceneVisualSystem,
  VesselHudState,
  WeatherVisualTarget,
} from '../scene/SceneVisualSystem';
import type { SnapshotActor } from '../network/protocol';
import type { ThreeMeshProxy } from '../render/three/ThreeMeshProxy';
import type { SceneBeforeRenderListener } from '../scene/components';
import type { SceneDefinition } from '../scenes/data/SceneDefinition';
import type { TerrainWorld } from '../world/TerrainWorld';
import type { PhysicsWorld } from '../../shared/physics/PhysicsWorld.mjs';
import { DEFAULT_WEATHER, type WeatherType } from '../weather/index';
import { DEFAULT_START_HOUR } from '../../shared/dayNight.mjs';

const EMPTY_SCENE_COLOR = 0xfdfbf6;

function createEmptyScene(): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(EMPTY_SCENE_COLOR);
  return scene;
}

function disposeScene(scene: THREE.Scene): void {
  scene.traverse((object) => {
    const renderable = object as THREE.Mesh & { material?: THREE.Material | THREE.Material[] };
    renderable.geometry?.dispose();
    if (Array.isArray(renderable.material)) {
      for (const material of renderable.material) material.dispose();
    } else {
      renderable.material?.dispose();
    }
  });
}

export class SceneRenderer implements GrassInteractionTarget {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  private scene = createEmptyScene();
  private visualSystems: SceneVisualSystem[] = [];
  private grassInteraction?: GrassInteractionTarget;
  private actorSnapshotTarget?: ActorSnapshotTarget;
  private weatherTarget?: WeatherVisualTarget;
  private dayNightTarget?: DayNightVisualTarget;
  private sceneEnvironmentRuntime?: SceneEnvironmentRuntime;
  private collisionWorld?: CollisionWorld;
  private terrainWorld?: TerrainWorld;
  private physicsWorld?: PhysicsWorld;
  private physicsDebug?: THREE.LineSegments;
  private terrainHighlight?: THREE.LineSegments;
  private fixedWaterWorld = false;
  private fixedWaterLevel = 0;
  private currentWeather: WeatherType = DEFAULT_WEATHER;
  private simpleCollisionVisible = false;
  private temperatureVisible = false;
  private readonly dynamicWorld = new THREE.Group();
  private readonly lookTarget = new THREE.Vector3();
  private readonly beforeRenderListeners = new Set<SceneBeforeRenderListener>();

  public constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(0xfdfbf6, 1);
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.scene.add(this.dynamicWorld);
  }

  public render(frame: CameraFrame): void {
    this.resizeToDisplaySize();
    this.camera.position.set(...frame.position);
    this.camera.up.set(...frame.axes.up);
    this.lookTarget.set(
      frame.position[0] + frame.axes.forward[0],
      frame.position[1] + frame.axes.forward[1],
      frame.position[2] + frame.axes.forward[2],
    );
    this.camera.lookAt(this.lookTarget);
    for (const listener of this.beforeRenderListeners) listener(this.camera);
    for (const system of this.visualSystems) {
      system.beforeRender?.(this.renderer, this.camera);
    }
    this.renderer.render(this.scene, this.camera);
  }

  public addWorldObject(object: THREE.Object3D): void {
    this.dynamicWorld.add(object);
  }

  public removeWorldObject(object: THREE.Object3D): void {
    this.dynamicWorld.remove(object);
  }

  /** 玩家、场景组件或玩法效果写入当前场景草地的统一入口。 */
  public applyImpulse(impulse: GrassBendImpulse): void {
    this.grassInteraction?.applyImpulse(impulse);
  }

  public get grassInteractionTarget(): GrassInteractionTarget | undefined {
    return this.grassInteraction;
  }

  public onBeforeRender(listener: SceneBeforeRenderListener): () => void {
    this.beforeRenderListeners.add(listener);
    return () => this.beforeRenderListeners.delete(listener);
  }

  public update(
    deltaSeconds: number,
    elapsedSeconds: number,
    context?: SceneUpdateContext,
  ): void {
    for (const system of this.visualSystems) system.update(deltaSeconds, elapsedSeconds, context);
    this.updatePhysicsDebug();
  }

  public syncActors(snapshots: readonly SnapshotActor[], serverTime: number): void {
    this.actorSnapshotTarget?.syncSnapshots(snapshots, serverTime);
  }

  public getActor(actorId: string): Actor | undefined {
    return this.actorSnapshotTarget?.getActor(actorId);
  }

  /** Actor 在渲染世界里的 proxy；Actor 自身只持有 proxyId。 */
  public getActorRenderProxy(actorId: string): ThreeMeshProxy | undefined {
    return this.actorSnapshotTarget?.getActorRenderProxy(actorId);
  }

  public findOwnedActorId(playerId: string): string | undefined {
    return this.actorSnapshotTarget?.findOwnedActorId(playerId);
  }

  public findControllableActorId(): string | undefined {
    return this.actorSnapshotTarget?.findControllableActorId();
  }

  public pickActorInteraction(frame: CameraFrame): ActorInteractionCandidate | undefined {
    return this.actorSnapshotTarget?.pickInteractableActor(
      frame.position,
      frame.axes.forward,
    );
  }

  public findNearbyActorInteraction(
    position: { x: number; z: number },
  ): ActorInteractionCandidate | undefined {
    return this.actorSnapshotTarget?.findNearbyInteractableActor(position);
  }

  public setHoveredActorId(actorId?: string): void {
    this.actorSnapshotTarget?.setHoveredActorId(actorId);
  }

  public setInteractionMarkerActorId(actorId?: string, inputLabel?: string): void {
    this.actorSnapshotTarget?.setInteractionMarkerActorId(actorId, inputLabel);
  }

  public getVesselHudState(playerId: string): VesselHudState | undefined {
    return this.actorSnapshotTarget?.getVesselHudState(playerId);
  }

  public sampleGroundHeight(x: number, z: number): number {
    return this.terrainWorld?.sampleGroundHeight(x, z) ?? 0;
  }

  /** 当前场景任意来源的地形 patch 通知。 */
  public onTerrainChanged(listener: () => void): () => void {
    return this.terrainWorld?.subscribe(listener) ?? (() => undefined);
  }

  public samplePlayerHeight(x: number, z: number, buoyancyDraft?: number): number {
    if (this.terrainWorld) return this.terrainWorld.sampleMovementHeight(x, z, buoyancyDraft);
    return this.fixedWaterWorld && Number.isFinite(buoyancyDraft)
      ? this.fixedWaterLevel - Math.max(0, Number(buoyancyDraft))
      : 0;
  }

  public getPhysicsWorld(): PhysicsWorld | undefined {
    return this.physicsWorld;
  }

  public isWaterAt(x: number, z: number): boolean {
    return this.terrainWorld?.isWaterAt(x, z) ?? this.fixedWaterWorld;
  }

  public raycastGround(
    origin: readonly [number, number, number],
    direction: readonly [number, number, number],
  ): { x: number; y: number; z: number } | undefined {
    return this.terrainWorld?.raycast(origin, direction);
  }

  /** 射线命中的地形格。UI 用它决定高亮哪一格、点下去改哪一格。 */
  public pickTerrainCell(
    origin: readonly [number, number, number],
    direction: readonly [number, number, number],
  ): { cellX: number; cellZ: number } | undefined {
    const hit = this.terrainWorld?.raycast(origin, direction);
    if (!hit) return undefined;
    return {
      cellX: Math.floor(hit.x / TERRAIN_CELL_SIZE),
      cellZ: Math.floor(hit.z / TERRAIN_CELL_SIZE),
    };
  }

  /**
   * 写入服务端确认过的地形覆盖。patch store 的订阅者会据此重建受影响的 chunk。
   * 客户端不做本地预测，所以这是覆盖层唯一的写入口。
   */
  public applyTerrainPatches(
    cells: readonly { cellX: number; cellZ: number; code: number }[],
  ): void {
    const terrain = this.terrainWorld;
    if (!terrain) return;
    for (const cell of cells) terrain.setCellCode(cell.cellX, cell.cellZ, cell.code);
  }

  /** 高亮一格地形；传 undefined 收起高亮。 */
  public setTerrainHighlight(cell?: { cellX: number; cellZ: number }): void {
    if (!cell || !this.terrainWorld) {
      if (this.terrainHighlight) this.terrainHighlight.visible = false;
      return;
    }
    if (!this.terrainHighlight) {
      this.terrainHighlight = createTerrainHighlight();
      this.addWorldObject(this.terrainHighlight);
    }
    const centerX = (cell.cellX + 0.5) * TERRAIN_CELL_SIZE;
    const centerZ = (cell.cellZ + 0.5) * TERRAIN_CELL_SIZE;
    // 贴着格心的地面画，抬高一点避免和地形共面闪烁。
    this.terrainHighlight.position.set(
      centerX,
      this.terrainWorld.sampleGroundHeight(centerX, centerZ) + 0.05,
      centerZ,
    );
    this.terrainHighlight.visible = true;
  }

  /**
   * 第三人称相机悬臂的探针：从角色到期望机位扫掠一个球，返回最早的命中位置
   * （线段参数 0–1，没挡住就是 1）。查询走 CAMERA 层，所以树冠这类
   * 「不挡走路但挡镜头」的体积也会被算进去。
   */
  public sweepCameraProbe(
    start: readonly [number, number, number],
    end: readonly [number, number, number],
    radius: number,
  ): number {
    return this.physicsWorld?.castCameraSphere(start, end, radius) ?? 1;
  }

  public setSimpleCollisionVisible(visible: boolean): void {
    this.simpleCollisionVisible = visible;
    this.actorSnapshotTarget?.setSimpleCollisionVisible(visible);
    if (this.physicsDebug) this.physicsDebug.visible = visible;
  }

  public get isSimpleCollisionVisible(): boolean {
    return this.simpleCollisionVisible;
  }

  public setTemperatureVisible(visible: boolean): void {
    this.temperatureVisible = visible;
    this.actorSnapshotTarget?.setTemperatureVisible(visible);
  }

  public get isTemperatureVisible(): boolean {
    return this.temperatureVisible;
  }

  public setWeather(weather: WeatherType): void {
    this.currentWeather = weather;
    this.weatherTarget?.setWeather(weather);
  }

  public get weather(): WeatherType {
    return this.currentWeather;
  }

  /**
   * 同步房间权威时刻。两帧快照之间由昼夜系统本地推进，这里只做校正，
   * 所以时间不会随快照频率跳动。
   */
  public setTimeOfDay(timeOfDay: number, dayLengthSeconds: number): void {
    this.dayNightTarget?.applyServerTime(timeOfDay, dayLengthSeconds);
  }

  /** 当前场景的共享光照与雾 uniform；场景 Component 的表现接到同一份上。 */
  public get environmentRuntime(): SceneEnvironmentRuntime | undefined {
    return this.sceneEnvironmentRuntime;
  }

  /** 当前渲染用的时刻；没有加载场景时回落到正午。 */
  public get timeOfDay(): number {
    return this.dayNightTarget?.timeOfDay ?? DEFAULT_START_HOUR;
  }

  /**
   * 加载场景。worldSeed 来自房间，决定流式世界长什么样；
   * 不做流式加载的场景会忽略它。
   */
  public loadScene(definition: SceneDefinition, worldSeed?: number): void {
    if (definition.renderer.type !== 'line-art') {
      throw new Error(`不支持的场景渲染器：${definition.renderer.type as string}`);
    }
    this.currentWeather = DEFAULT_WEATHER;
    this.fixedWaterWorld = definition.renderer.content.ocean === true
      && definition.renderer.content.ground === false;
    this.fixedWaterLevel = definition.gameplay.water?.seaLevel ?? 0;
    this.replaceScene(createLineArtScene(definition, worldSeed));
  }

  public showEmptyScene(): void {
    this.currentWeather = DEFAULT_WEATHER;
    this.fixedWaterWorld = false;
    this.fixedWaterLevel = 0;
    this.replaceScene({ scene: createEmptyScene(), visualSystems: [] });
  }

  private replaceScene(composition: SceneComposition): void {
    for (const system of this.visualSystems) system.dispose?.();
    this.scene.remove(this.dynamicWorld);
    disposeScene(this.scene);
    // 碰撞世界随场景走：上一张地图的 chunk 与 Actor 碰撞体一起被丢掉，
    // 不会有残留的盒子挡住新地图里的路。
    this.collisionWorld?.clear();
    this.physicsWorld?.dispose();
    this.scene = composition.scene;
    this.visualSystems = composition.visualSystems;
    this.weatherTarget = composition.weatherTarget;
    this.dayNightTarget = composition.dayNightTarget;
    this.sceneEnvironmentRuntime = composition.environmentRuntime;
    this.grassInteraction = composition.grassInteraction;
    this.actorSnapshotTarget = composition.actorSnapshotTarget;
    this.collisionWorld = composition.collisionWorld;
    this.terrainWorld = composition.terrainWorld;
    this.physicsWorld = composition.physicsWorld;
    if (this.physicsDebug) this.physicsDebug.visible = Boolean(this.physicsWorld)
      && this.simpleCollisionVisible;
    this.actorSnapshotTarget?.setSimpleCollisionVisible(this.simpleCollisionVisible);
    this.actorSnapshotTarget?.setTemperatureVisible(this.temperatureVisible);
    this.weatherTarget?.setWeather(this.currentWeather);
    this.scene.add(this.dynamicWorld);
  }

  private updatePhysicsDebug(): void {
    if (!this.simpleCollisionVisible || !this.physicsWorld) return;
    const buffers = this.physicsWorld.debugRender();
    if (!this.physicsDebug) {
      this.physicsDebug = new THREE.LineSegments(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false }),
      );
      this.physicsDebug.name = 'rapier-physics-debug';
      this.physicsDebug.renderOrder = 998;
      this.physicsDebug.frustumCulled = false;
      this.dynamicWorld.add(this.physicsDebug);
    }
    const colors = new Float32Array((buffers.colors.length / 4) * 3);
    for (let source = 0, target = 0; source < buffers.colors.length; source += 4) {
      colors[target++] = buffers.colors[source];
      colors[target++] = buffers.colors[source + 1];
      colors[target++] = buffers.colors[source + 2];
    }
    this.physicsDebug.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(buffers.vertices, 3),
    );
    this.physicsDebug.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.physicsDebug.geometry.computeBoundingSphere();
    this.physicsDebug.visible = true;
  }

  private resizeToDisplaySize(): void {
    const canvas = this.renderer.domElement;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.75);
    const width = Math.max(1, Math.floor(canvas.clientWidth));
    const height = Math.max(1, Math.floor(canvas.clientHeight));
    const requiredWidth = Math.floor(width * pixelRatio);
    const requiredHeight = Math.floor(height * pixelRatio);

    if (canvas.width !== requiredWidth || canvas.height !== requiredHeight) {
      this.renderer.setPixelRatio(pixelRatio);
      this.renderer.setSize(width, height, false);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
  }
}

/**
 * 一格地形的高亮框：贴地的方框加四个角柱，线稿风格下比半透明面片更清楚，
 * 也不需要额外的透明排序。
 */
function createTerrainHighlight(): THREE.LineSegments {
  const half = TERRAIN_CELL_SIZE / 2;
  const corner = TERRAIN_CELL_SIZE * 0.22;
  const points: number[] = [];
  const square: Array<[number, number]> = [
    [-half, -half], [half, -half], [half, half], [-half, half],
  ];
  for (let index = 0; index < square.length; index += 1) {
    const [fromX, fromZ] = square[index];
    const [toX, toZ] = square[(index + 1) % square.length];
    points.push(fromX, 0, fromZ, toX, 0, toZ);
    // 角柱：从地面往上一小截，斜坡上也能一眼看出选中的是哪一格。
    points.push(fromX, 0, fromZ, fromX, corner, fromZ);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  const material = new THREE.LineBasicMaterial({ color: 0xf0a33c, depthTest: false });
  const lines = new THREE.LineSegments(geometry, material);
  lines.name = 'terrain-edit-highlight';
  lines.renderOrder = 999;
  lines.frustumCulled = false;
  return lines;
}
