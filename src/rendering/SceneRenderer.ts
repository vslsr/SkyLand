import * as THREE from 'three';
import { TERRAIN_CELL_SIZE } from '../../shared/world/terrainConfig.mjs';
import type { CollisionWorld } from '../../shared/collision/index.mjs';
import type { CameraFrame } from '../camera/CameraTransform';
import {
  createRenderCamera,
  RenderCameraBuffer,
  type RenderCamera,
} from '../render/RenderCameraBuffer';
import type { PointerViewport } from '../grass';

/** 透视相机的视场角（度）。反投影要用同一个值，所以它是个常量而不是字面量。 */
const CAMERA_FIELD_OF_VIEW = 50;
import { type GrassInteractionTarget } from '../grass';
import { frameTimeline } from '../platform/index';
import { releaseOwnResources } from '../render/renderAssets';
import { createLineArtScene } from '../scene/createLineArtScene';
import type { DayNightVisualTarget } from '../environment/EnvironmentTypes';
import type { SceneEnvironmentRuntime } from '../materials/createFillMaterial';
import type {
  ActorSnapshotTarget,
  SceneComposition,
  SceneUpdateContext,
  SceneFrameSystem,
  WeatherVisualTarget,
} from '../scene/SceneVisualSystem';
import type { ThreeMeshProxy } from '../render/three/ThreeMeshProxy';
import type { ThreeRenderScene } from '../render/three/ThreeRenderScene';
import type { RenderWorldHandle } from '../render/RenderProxyTable';
import type { SceneBeforeRenderListener } from '../scene/components';
import type { SceneDefinition } from '../scenes/data/SceneDefinition';
import type { SceneWorld } from '../scene/SceneWorld';
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

/**
 * 换场景时释放上一张地图的 GPU 资源。
 *
 * 遍历式释放是路线图 §8.2 里那条要被替换掉的规则——它会无差别 dispose 每一个
 * geometry 与 material，包括别人共享的那些。在全部资源转成句柄之前，先让它
 * 避让所有权表管着的东西。
 */
function disposeScene(scene: THREE.Scene): void {
  scene.traverse(releaseOwnResources);
}

export class SceneRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera = new THREE.PerspectiveCamera(CAMERA_FIELD_OF_VIEW, 1, 0.1, 100);
  private scene = createEmptyScene();
  private visualSystems: SceneFrameSystem[] = [];
  private grassInteraction?: GrassInteractionTarget;
  private actorSnapshotTarget?: ActorSnapshotTarget;
  /** 当前地图的渲染世界。整张对象随场景一起换掉，所以引用可以直接比身份。 */
  private renderWorldHandle?: RenderWorldHandle<ThreeRenderScene>;
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
  /**
   * 相机过边界的那一段字节，以及读出来落脚的地方。
   *
   * 属于渲染器而不是场景：换地图会换掉整个渲染世界，相机却是一直在的
   * （大厅 → 房间 → 大厅 都是同一个）。
   */
  private readonly cameraChannel = new RenderCameraBuffer();
  private readonly cameraFrame = createRenderCamera();
  private readonly beforeRenderListeners = new Set<SceneBeforeRenderListener>();

  /**
   * `world` 是这张地图**不属于渲染**的那一半（地形、物理、Actor 查询）。
   *
   * 场景组合仍然由这个类装配（`loadScene` → `createLineArtScene`），所以换场景时
   * 由它把玩法那一半交给 `SceneWorld`。第 3 步 canvas 交给渲染线程之后，
   * 装配会跟着一起搬走，那时这条依赖反过来——但现在先把**接口**拆干净。
   */
  public constructor(canvas: HTMLCanvasElement, private readonly world: SceneWorld) {
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

  /**
   * 玩法侧每 tick 写一次机位并翻面。
   *
   * 收 `CameraFrame` 是因为算相机的那一半（跟随、悬臂、模式过渡）在玩法侧，
   * 它本来就产出这个结构；这里只负责把其中真正过边界的九个数摊进字节。
   */
  public publishCamera(frame: CameraFrame): void {
    this.cameraChannel.write(frame.position, frame.axes.forward, frame.axes.up);
    this.cameraChannel.publish();
  }

  /**
   * 主线程这一侧的相机视图：机位朝向 + 投影参数。
   *
   * **不是从渲染世界读回来的**——机位是玩法侧每 tick 写进那段字节的，
   * 视场角是常量，宽高比来自画布。输入适配器（鼠标拖草）要反投影就用这个，
   * 不需要回调进渲染侧去借一个 `THREE.Camera`。
   */
  public getCameraView(): { camera: RenderCamera; viewport: PointerViewport } {
    // 画布尺寸从渲染器身上问：canvas 搬走之后这一行换成主线程自己记的那份。
    const element = this.renderer.domElement;
    const width = Math.max(1, element.clientWidth || element.width);
    const height = Math.max(1, element.clientHeight || element.height);
    return {
      camera: this.cameraChannel.read(this.cameraFrame),
      viewport: { fovRadians: (CAMERA_FIELD_OF_VIEW * Math.PI) / 180, aspect: width / height },
    };
  }

  /**
   * 画一帧。
   *
   * 机位**不再由参数传进来**（实现路径文档 §3）：它从 `camera` 那段字节里读。
   * 玩法侧每 tick 写一次并翻面，这里读的永远是完整的一帧。canvas 交给渲染线程
   * 之后这个方法跑在那一侧，那时它读的是同一段 `SharedArrayBuffer`，
   * 调用方不用改。
   */
  public render(): void {
    this.resizeToDisplaySize();
    const frame = this.cameraChannel.read(this.cameraFrame);
    this.camera.position.set(...frame.position);
    this.camera.up.set(...frame.up);
    this.lookTarget.set(
      frame.position[0] + frame.forward[0],
      frame.position[1] + frame.forward[1],
      frame.position[2] + frame.forward[2],
    );
    this.camera.lookAt(this.lookTarget);
    for (const listener of this.beforeRenderListeners) listener(this.camera);
    for (const system of this.visualSystems) {
      system.beforeRender?.(this.renderer, this.camera);
    }
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * 当前地图的渲染世界。玩家实体（本地与远端）经由它建自己的 proxy——
   * 它们不是 Replica，但必须和 Actor 共用同一个渲染世界、同一段边界字节，
   * 以及同一张槽位表。
   */
  public get renderWorld(): RenderWorldHandle<ThreeRenderScene> | undefined {
    return this.renderWorldHandle;
  }

  public addWorldObject(object: THREE.Object3D): void {
    this.dynamicWorld.add(object);
  }

  public removeWorldObject(object: THREE.Object3D): void {
    this.dynamicWorld.remove(object);
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
    // 逐个系统打点太碎；这里只分「Actor 世界那一支（自己再细分）」与「其余场景系统」，
    // 后者是草地、天气、昼夜、海面、chunk 流送这一批。
    for (const system of this.visualSystems) {
      if (system === (this.actorSnapshotTarget as unknown)) {
        system.update(deltaSeconds, elapsedSeconds, context);
        continue;
      }
      frameTimeline.measure(
        'scene-systems',
        () => system.update(deltaSeconds, elapsedSeconds, context),
      );
    }
    this.updatePhysicsDebug();
  }

  public getActorRenderProxy(actorId: string): ThreeMeshProxy | undefined {
    return this.actorSnapshotTarget?.getActorRenderProxy(actorId);
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
    this.world.clear();
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
    this.world.adopt(composition, {
      fixedWaterWorld: this.fixedWaterWorld,
      fixedWaterLevel: this.fixedWaterLevel,
    });
    this.renderWorldHandle = composition.renderScene
      && composition.renderTransforms
      && composition.renderProxyIds
      ? {
        scene: composition.renderScene,
        transforms: composition.renderTransforms,
        proxyIds: composition.renderProxyIds,
      }
      : undefined;
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
