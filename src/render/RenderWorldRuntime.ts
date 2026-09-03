import * as THREE from 'three';
import { TERRAIN_CELL_SIZE } from '../../shared/world/terrainConfig.mjs';
import type { GrassBendImpulse } from '../grass';
import { createRenderWorld, type RenderWorldComposition } from '../scene/createRenderWorld';
import type { SceneFrameSystem, SceneUpdateContext } from '../scene/SceneVisualSystem';
import type { SceneDefinition } from '../scenes/data/SceneDefinition';
import { DEFAULT_WEATHER, type WeatherType } from '../weather/index';
import { releaseOwnResources } from './renderAssets';
import { RenderCameraBuffer, createRenderCamera } from './RenderCameraBuffer';
import type { ChunkViewSink } from '../world/ChunkViewHost';
import type { RenderScene, SlimeSurfaceDragListener } from './RenderScene';
import { RenderTransformBuffer } from './RenderTransformBuffer';

/** 主线程那台相机的视场角。渲染世界只在算投影矩阵时用它。 */
export const CAMERA_FIELD_OF_VIEW = 50;

const EMPTY_SCENE_COLOR = 0xfdfbf6;

/**
 * 渲染世界能收到的全部命令（引擎迁移路线图 第 3 步）。
 *
 * **每一条都返回 `void`**，理由和 `RenderScene` 上那条一样：这些方法上 worker 之后
 * 就是报文。`RenderScene` 管的是「一个 proxy 怎么画」，这个接口管的是
 * 「这张地图整体怎么回事」——换地图、天气、时刻、视口、调试线框。
 *
 * 分成两个接口而不是一个，是因为它们的收件人不同：`RenderScene` 的收件人是
 * 一张地图的渲染世界（换地图就整个换掉），这个接口的收件人是**渲染循环本身**
 * （从大厅到房间再回大厅，它一直是同一个）。
 */
export interface RenderWorldCommands {
  /** 换一张地图。渲染那一半由这一侧自己按定义与种子建——不从外面递进来。 */
  loadRenderScene(definition: SceneDefinition, worldSeed?: number): void;
  /** 退回什么都没有的画面（大厅背后那个）。 */
  clearRenderScene(): void;
  /**
   * 画布的 CSS 尺寸与像素比。
   *
   * **由主线程量**：`clientWidth` 与 `devicePixelRatio` 是 DOM 的事，
   * `transferControlToOffscreen` 之后画布元素仍然留在那一侧，只有绘制上下文走了。
   */
  setViewport(cssWidth: number, cssHeight: number, pixelRatio: number): void;
  setWeather(weather: WeatherType): void;
  setTimeOfDay(timeOfDay: number, running: boolean): void;
  setSceneActive(active: boolean): void;
  setTerrainCells(cells: readonly { cellX: number; cellZ: number; code: number }[]): void;
  setTerrainHighlight(cell?: { cellX: number; cellZ: number }): void;
  /**
   * 物理调试线框这一帧的顶点与颜色。
   *
   * 是**推**不是拉：物理世界归玩法那一半持有，渲染侧问不到它。传 `undefined`
   * 收起线框。颜色是 RGBA，摊成 RGB 由这一侧做——那是画法，不是事实。
   */
  setPhysicsDebug(buffers?: { vertices: Float32Array; colors: Float32Array }): void;
  applyGrassImpulse(impulse: GrassBendImpulse): void;
  /** 焦点与玩家身影的位置。渲染侧的流式草、落叶按它铺。 */
  setFrameContext(context: SceneUpdateContext): void;
}

/**
 * 渲染世界这一端的**全部**：整图级命令，加上玩法侧要用的三个口子。
 *
 * 单线程下 `RenderWorldRuntime` 本人就是它；渲染循环进 worker 之后由命令队列顶上，
 * 装配（`SceneCompositionHost`）与门面（`SceneRenderer`）一个字都不用改。
 */
export interface RenderWorldPort extends RenderWorldCommands {
  /** proxy 命令口。没加载地图时是 undefined。 */
  readonly scene?: RenderScene;
  /** 那段边界字节。归连接持有，从头到尾都在。 */
  readonly transforms: RenderTransformBuffer;
  /** 挂载命令口。流式地图才有。 */
  readonly chunkViews?: ChunkViewSink;
  update(deltaSeconds: number, elapsedSeconds: number): void;
  render(): void;
}

/**
 * 主线程手上的「渲染那一侧」：一个命令口，加上相机那段字节。
 *
 * 两样凑一对是因为它们一起换：渲染循环进 worker 那天，`port` 变成命令队列，
 * `camera` 变成一块 `SharedArrayBuffer`——而拿着它们的那几个类
 * （`SceneRenderer`、`SceneWorld`、`SceneCompositionHost`）一个字都不用改。
 */
export interface RenderWorldConnection {
  readonly port: RenderWorldPort;
  readonly camera: RenderCameraBuffer;
}

/** 就地那一版：渲染世界和玩法在同一条线程上，命令就是直接调用。 */
export function connectRenderWorldInProcess(
  canvas: HTMLCanvasElement | OffscreenCanvas,
): RenderWorldConnection {
  const camera = new RenderCameraBuffer();
  const transforms = new RenderTransformBuffer();
  return { port: new RenderWorldRuntime(canvas, camera, transforms), camera };
}

/**
 * 渲染循环本身：画布、`WebGLRenderer`、一张地图的渲染世界，以及每帧那两步。
 *
 * 这个类是**第 3 步要搬进 worker 的全部**。它成立的判据只有一条：
 * 构造它只需要一个画布，此后所有输入都是命令与字节，没有一样是玩法侧的对象。
 * 所以它在主线程跑（`canvas`）和在 worker 里跑（`OffscreenCanvas`）是同一份代码。
 *
 * 相机不由参数传进来，从 `RenderCameraBuffer` 那段字节读——玩法侧每 tick 写一次并
 * 翻面，读到的永远是完整的一帧。上 worker 之后那是同一块 `SharedArrayBuffer`。
 */
export class RenderWorldRuntime implements RenderWorldPort {
  readonly #renderer: THREE.WebGLRenderer;
  readonly #camera = new THREE.PerspectiveCamera(CAMERA_FIELD_OF_VIEW, 1, 0.1, 100);
  readonly #dynamicWorld = new THREE.Group();
  readonly #lookTarget = new THREE.Vector3();
  readonly #cameraFrame = createRenderCamera();
  #scene = createEmptyScene();
  #composition?: RenderWorldComposition;
  #visualSystems: SceneFrameSystem[] = [];
  #physicsDebug?: THREE.LineSegments;
  #terrainHighlight?: THREE.LineSegments;
  #weather: WeatherType = DEFAULT_WEATHER;
  #sceneActive = false;
  #frameContext?: SceneUpdateContext;
  #viewport = { cssWidth: 1, cssHeight: 1, pixelRatio: 1 };
  #slimeDragListener?: SlimeSurfaceDragListener;
  #generatorReadyListener?: (kind: string) => void;

  public constructor(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    /** 相机那段字节。玩法侧写，这里读——两侧看的是同一块内存。 */
    private readonly cameraChannel: RenderCameraBuffer,
    /** transform SoA。同样归连接持有，跨线程时是同一块 `SharedArrayBuffer`。 */
    public readonly transforms: RenderTransformBuffer,
  ) {
    this.#renderer = new THREE.WebGLRenderer({
      canvas: canvas as HTMLCanvasElement,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.#renderer.setClearColor(EMPTY_SCENE_COLOR, 1);
    this.#renderer.outputEncoding = THREE.sRGBEncoding;
    this.#scene.add(this.#dynamicWorld);
  }

  /**
   * 玩法侧要往这里发命令的那三个口子。
   *
   * 单线程下调用方拿到的就是真东西；上 worker 之后同一组口子由
   * `RenderCommandQueue` 顶上，玩法侧的代码一个字都不用改。
   */
  public get scene(): RenderScene | undefined {
    return this.#composition?.renderScene;
  }

  public get chunkViews(): ChunkViewSink | undefined {
    return this.#composition?.chunkViews;
  }

  /**
   * 蒙皮拖拽的回报口子，**装在渲染循环上而不是某一张地图上**。
   *
   * 换地图会换掉整个渲染世界，而收报的那一方（跨线程时是主线程那个代理）不换。
   * 所以这里记住它，每次装上新地图时替它接到新的 `RenderScene` 上。
   */
  public setSlimeSurfaceDragListener(listener?: SlimeSurfaceDragListener): void {
    this.#slimeDragListener = listener;
    this.#composition?.renderScene.setSlimeSurfaceDragListener(listener);
  }

  /**
   * chunk 生成后端就位的回报口子，和拖拽那条一样装在渲染循环上。
   *
   * `ChunkStreamer` 在它就位之前一个 chunk 都不规划——先规划会注册出一批
   * 「踩得到但看不见」的碰撞体。跨线程时这条不接回去，流式地图就是一片空白。
   */
  public setGeneratorReadyListener(listener?: (kind: string) => void): void {
    this.#generatorReadyListener = listener;
    if (listener) this.#composition?.chunkViews?.onGeneratorReady(listener);
  }

  public loadRenderScene(definition: SceneDefinition, worldSeed?: number): void {
    if (definition.renderer.type !== 'line-art') {
      throw new Error(`不支持的场景渲染器：${definition.renderer.type as string}`);
    }
    this.#weather = DEFAULT_WEATHER;
    this.#install(createRenderWorld(definition, worldSeed, this.transforms));
  }

  public clearRenderScene(): void {
    this.#weather = DEFAULT_WEATHER;
    this.#install(undefined);
  }

  public setViewport(cssWidth: number, cssHeight: number, pixelRatio: number): void {
    this.#viewport = {
      cssWidth: Math.max(1, Math.floor(cssWidth)),
      cssHeight: Math.max(1, Math.floor(cssHeight)),
      pixelRatio: Math.max(0.1, pixelRatio),
    };
  }

  public setWeather(weather: WeatherType): void {
    this.#weather = weather;
    this.#composition?.weatherTarget.setWeather(weather);
  }

  public setTimeOfDay(timeOfDay: number, running: boolean): void {
    this.#composition?.dayNightTarget.setTimeOfDay(timeOfDay, running);
  }

  public setSceneActive(active: boolean): void {
    this.#sceneActive = active;
    this.#composition?.setSceneActive(active);
  }

  public setTerrainCells(
    cells: readonly { cellX: number; cellZ: number; code: number }[],
  ): void {
    this.#composition?.setTerrainCells(cells);
  }

  /** 高亮一格地形；传 undefined 收起高亮。高度由这一侧自己那份地形算。 */
  public setTerrainHighlight(cell?: { cellX: number; cellZ: number }): void {
    if (!cell) {
      if (this.#terrainHighlight) this.#terrainHighlight.visible = false;
      return;
    }
    if (!this.#terrainHighlight) {
      this.#terrainHighlight = createTerrainHighlight();
      this.#dynamicWorld.add(this.#terrainHighlight);
    }
    const centerX = (cell.cellX + 0.5) * TERRAIN_CELL_SIZE;
    const centerZ = (cell.cellZ + 0.5) * TERRAIN_CELL_SIZE;
    // 贴着格心的地面画，抬高一点避免和地形共面闪烁。
    this.#terrainHighlight.position.set(
      centerX,
      (this.#composition?.sampleGroundHeight(centerX, centerZ) ?? 0) + 0.05,
      centerZ,
    );
    this.#terrainHighlight.visible = true;
  }

  public setPhysicsDebug(buffers?: { vertices: Float32Array; colors: Float32Array }): void {
    if (!buffers) {
      if (this.#physicsDebug) this.#physicsDebug.visible = false;
      return;
    }
    if (!this.#physicsDebug) {
      this.#physicsDebug = new THREE.LineSegments(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false }),
      );
      this.#physicsDebug.name = 'rapier-physics-debug';
      this.#physicsDebug.renderOrder = 998;
      this.#physicsDebug.frustumCulled = false;
      this.#dynamicWorld.add(this.#physicsDebug);
    }
    // Rapier 给的是 RGBA，线材质只吃 RGB。摊平是画法，不是事实，所以在这一侧做。
    const colors = new Float32Array((buffers.colors.length / 4) * 3);
    for (let source = 0, target = 0; source < buffers.colors.length; source += 4) {
      colors[target++] = buffers.colors[source];
      colors[target++] = buffers.colors[source + 1];
      colors[target++] = buffers.colors[source + 2];
    }
    this.#physicsDebug.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(buffers.vertices, 3),
    );
    this.#physicsDebug.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.#physicsDebug.geometry.computeBoundingSphere();
    this.#physicsDebug.visible = true;
  }

  public applyGrassImpulse(impulse: GrassBendImpulse): void {
    this.#composition?.grassInteraction?.applyImpulse(impulse);
  }

  public setFrameContext(context: SceneUpdateContext): void {
    this.#frameContext = context;
  }

  /**
   * 渲染世界这一帧。
   *
   * 顺序是有约束的：表现系统先跑（它们读上一次翻面的那段字节），
   * 然后 `updateVisuals` 兑现 proxy 的姿态与动画。
   */
  public update(deltaSeconds: number, elapsedSeconds: number): void {
    for (const system of this.#visualSystems) {
      system.update(deltaSeconds, elapsedSeconds, this.#frameContext);
    }
    const composition = this.#composition;
    if (!composition) return;
    composition.renderScene.updateVisuals(
      composition.transforms,
      deltaSeconds,
      elapsedSeconds,
    );
  }

  /** 画一帧。机位从那段字节里读，不由参数传进来。 */
  public render(): void {
    this.#resize();
    const frame = this.cameraChannel.read(this.#cameraFrame);
    this.#camera.position.set(...frame.position);
    this.#camera.up.set(...frame.up);
    this.#lookTarget.set(
      frame.position[0] + frame.forward[0],
      frame.position[1] + frame.forward[1],
      frame.position[2] + frame.forward[2],
    );
    this.#camera.lookAt(this.#lookTarget);
    for (const system of this.#visualSystems) {
      system.beforeRender?.(this.#renderer, this.#camera);
    }
    // 引导线宽要 resize 之后的真实画布尺寸，世界 UI 要相机朝向。两个参数都是
    // 渲染循环自己手里的东西，跨边界发过来毫无意义。
    this.#composition?.renderScene.beforeRender(this.#renderer, this.#camera);
    this.#renderer.render(this.#scene, this.#camera);
  }

  public dispose(): void {
    this.#install(undefined);
    this.#renderer.dispose();
  }

  #install(next: RenderWorldComposition | undefined): void {
    for (const system of this.#visualSystems) system.dispose?.();
    this.#scene.remove(this.#dynamicWorld);
    disposeScene(this.#scene);
    // 空组合不带场景图：大厅背后那个什么都没有的画面归这一侧自己铺。
    this.#scene = next?.scene ?? createEmptyScene();
    this.#composition = next;
    this.#visualSystems = next?.visualSystems ?? [];
    // 换了组合就把当前的进入状态补上去，否则先 onEnter 后加载的场景永远不激活。
    next?.renderScene.setSlimeSurfaceDragListener(this.#slimeDragListener);
    if (this.#generatorReadyListener) {
      next?.chunkViews?.onGeneratorReady(this.#generatorReadyListener);
    }
    next?.setSceneActive(this.#sceneActive);
    next?.weatherTarget.setWeather(this.#weather);
    // 线框由下一次 setPhysicsDebug 按「开关开着 + 这张图有物理世界」重新决定。
    if (this.#physicsDebug) this.#physicsDebug.visible = false;
    this.#scene.add(this.#dynamicWorld);
  }

  #resize(): void {
    const { cssWidth, cssHeight, pixelRatio } = this.#viewport;
    const canvas = this.#renderer.domElement;
    const requiredWidth = Math.floor(cssWidth * pixelRatio);
    const requiredHeight = Math.floor(cssHeight * pixelRatio);
    if (canvas.width === requiredWidth && canvas.height === requiredHeight) return;
    this.#renderer.setPixelRatio(pixelRatio);
    this.#renderer.setSize(cssWidth, cssHeight, false);
    this.#camera.aspect = cssWidth / cssHeight;
    this.#camera.updateProjectionMatrix();
  }
}

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
