import type {
  AbilityLabAction,
  AbilityLabViewState,
} from '../abilities/lab/AbilityLabSimulation';
import type { CameraFrame } from '../camera/CameraTransform';
import {
  createRenderCamera,
  RenderCameraBuffer,
  type RenderCamera,
} from '../render/RenderCameraBuffer';
import type { PointerViewport } from '../grass';
import { frameTimeline } from '../platform/index';
import {
  CAMERA_FIELD_OF_VIEW,
  type RenderWorldConnection,
  type RenderWorldPort,
} from '../render/RenderWorldRuntime';
import type {
  ActorSnapshotTarget,
  SceneComposition,
  SceneUpdateContext,
  SceneFrameSystem,
} from '../scene/SceneVisualSystem';
import type {
  BallisticPreviewState,
  BuildPreviewState,
  ProxyId,
} from '../render/RenderScene';
import type { RenderWorldHandle } from '../render/RenderProxyTable';
import type { SceneDefinition } from '../scenes/data/SceneDefinition';
import type { SceneWorld } from '../scene/SceneWorld';
import { DEFAULT_WEATHER, type WeatherType } from '../weather/index';
import { DEFAULT_START_HOUR } from '../../shared/dayNight.mjs';
import { DayNightClock } from '../environment/DayNightClock';

/**
 * 主线程这一侧的渲染门面（引擎迁移路线图 第 3 步）。
 *
 * **这个类里一个 `THREE` 都没有。** 画布、`WebGLRenderer`、场景图、表现系统
 * 全在 `RenderWorldRuntime` 里；这一侧只做四件跨不过去的事：
 *
 * 1. 量画布——`clientWidth` 与 `devicePixelRatio` 是 DOM 的事，
 *    `transferControlToOffscreen` 之后画布元素仍留在主线程，只有绘制上下文走了
 * 2. 推进昼夜时钟，每帧把小时数发过去
 * 3. 把机位摊进 `RenderCameraBuffer`，并按同一份数据回答「反投影用的视图」
 * 4. 驱动**玩法侧**那批每帧系统，然后让渲染世界跑它自己那一帧
 *
 * 其余全部是转发。`runtime` 现在是就地那个真对象；换成 worker 之后它变成一个
 * 命令队列，这个类一个字都不用改——那正是它上面每个方法都返回 `void` 的原因。
 */
export class SceneRenderer {
  private readonly runtime: RenderWorldPort;
  private readonly cameraChannel: RenderCameraBuffer;
  private visualSystems: SceneFrameSystem[] = [];
  private actorSnapshotTarget?: ActorSnapshotTarget;
  private renderWorldHandle?: RenderWorldHandle;
  private currentWeather: WeatherType = DEFAULT_WEATHER;
  private simpleCollisionVisible = false;
  private temperatureVisible = false;
  /**
   * 昼夜时钟（引擎迁移路线图 第 3 步）。
   *
   * 它原来住在 `DayNightSystem` 里，于是「现在几点」要从渲染世界读回来——调试菜单
   * 的时钟就是那么显示的。`DayNightClock` 是纯状态（不 import three），
   * 本来就不该在那一侧。现在这边推进、这边校正，每帧把小时数**发**过去。
   */
  private readonly dayNightClock = new DayNightClock(DEFAULT_START_HOUR, 0);
  private readonly cameraFrame = createRenderCamera();
  /** 上一次发过去的画布尺寸，用来只在变了时才发一条命令。 */
  private viewport = { width: 0, height: 0, pixelRatio: 0 };

  /**
   * `world` 是这张地图**不属于渲染**的那一半（地形、物理、Actor 查询）。
   * 物理调试线框的顶点从那里取，然后**推**给渲染世界——物理世界只该被一处持有。
   */
  public constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly world: SceneWorld,
    /**
     * 渲染那一侧。**由外面建好递进来**，因为 `SceneWorld` 也要往它发命令
     * （草地脉冲、地形编辑镜像），两个消费者不能各建一个。
     *
     * 相机那段字节属于连接而不是场景：换地图会换掉整个渲染世界，相机却是一直在的
     * （大厅 → 房间 → 大厅 都是同一个）。
     */
    connection: RenderWorldConnection,
  ) {
    this.runtime = connection.port;
    this.cameraChannel = connection.camera;
  }

  /**
   * 玩法侧每 tick 写一次机位并翻面。
   *
   * 收 `CameraFrame` 是因为算相机的那一半（跟随、悬臂、模式过渡）在玩法侧，
   * 它本来就产出这个结构；这里只负责把其中真正过边界的九个数摊进字节。
   *
   * 必须排在这一帧的 transform 翻面之后调：机位带着刚翻出去的 transform 帧号一起
   * 翻面，渲染线程靠这个号核对相机与世界是不是同一帧（`RenderCameraBuffer`）。
   */
  public publishCamera(frame: CameraFrame): void {
    this.cameraChannel.write(frame.position, frame.axes.forward, frame.axes.up);
    this.cameraChannel.publish(this.runtime.transforms.frameId);
  }

  /**
   * 主线程这一侧的相机视图：机位朝向 + 投影参数。
   *
   * **不是从渲染世界读回来的**——机位是玩法侧每 tick 写进那段字节的，
   * 视场角是常量，宽高比来自画布元素（它没跟着绘制上下文走）。
   * 输入适配器（鼠标拖草）要反投影就用这个。
   */
  public getCameraView(): { camera: RenderCamera; viewport: PointerViewport } {
    const { width, height } = this.measureCanvas();
    return {
      camera: this.cameraChannel.read(this.cameraFrame),
      viewport: { fovRadians: (CAMERA_FIELD_OF_VIEW * Math.PI) / 180, aspect: width / height },
    };
  }

  /**
   * 画一帧。画布尺寸在这一侧量好发过去，其余全在渲染世界里。
   *
   * 尺寸只在变了的时候才发：跨线程时每一条命令都是报文里的一项，而窗口大小
   * 一局里变不了几次。
   */
  public render(): void {
    const viewport = this.measureCanvas();
    if (
      viewport.width !== this.viewport.width
      || viewport.height !== this.viewport.height
      || viewport.pixelRatio !== this.viewport.pixelRatio
    ) {
      this.viewport = viewport;
      this.runtime.setViewport(viewport.width, viewport.height, viewport.pixelRatio);
    }
    frameTimeline.measure('draw', () => this.runtime.render());
  }

  /**
   * 当前地图的渲染世界。玩家实体（本地与远端）经由它建自己的 proxy——
   * 它们不是 Replica，但必须和 Actor 共用同一个渲染世界、同一段边界字节，
   * 以及同一张槽位表。
   */
  public get renderWorld(): RenderWorldHandle | undefined {
    return this.renderWorldHandle;
  }

  public update(
    deltaSeconds: number,
    elapsedSeconds: number,
    context?: SceneUpdateContext,
  ): void {
    // 时钟在这一侧推进，然后把结果发给渲染世界。一个时刻只有一份，
    // 不会因为两侧各推各的而漂开。
    this.dayNightClock.advance(Math.max(0, Math.min(deltaSeconds, 0.1)));
    this.runtime.setTimeOfDay(this.dayNightClock.timeOfDay, this.dayNightClock.running);
    if (context) this.runtime.setFrameContext(context);
    // 逐个系统打点太碎；这里只分「Actor 世界那一支（自己再细分）」与「其余玩法系统」，
    // 后者眼下只有 chunk 流送的规划。
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
    // 物理线框的数据源在玩法这一半，所以是**推**过去的，不是渲染侧回头来拉。
    this.runtime.setPhysicsDebug(
      this.simpleCollisionVisible ? this.world.debugRenderPhysics() : undefined,
    );
    // 渲染阶段：玩法那一批全部跑完、SoA 也翻过面之后，渲染世界才跑自己的一帧。
    // 渲染循环进 worker 那天，要搬走的就是这一句和 `render()`。
    frameTimeline.measure(
      'render-visuals',
      () => this.runtime.update(deltaSeconds, elapsedSeconds),
    );
  }

  /**
   * 能力实验室的三条命令，转发给渲染世界（引擎迁移路线图 第 3 步）。
   *
   * 这里原来是 `getActorRenderProxy`——把渲染世界里活的 `ThreeMeshProxy` 递给
   * 玩法侧的场景组件。整套动画搬进渲染世界之后，这一层只剩转发。
   */
  public setAbilityLabTarget(id: ProxyId): void {
    this.renderWorldHandle?.scene.setAbilityLabTarget(id);
  }

  public setAbilityLabState(
    state: AbilityLabViewState | undefined,
    casterX: number,
    casterY: number,
    casterZ: number,
  ): void {
    this.renderWorldHandle?.scene.setAbilityLabState(state, casterX, casterY, casterZ);
  }

  public playAbilityLabAction(
    action: AbilityLabAction,
    casterX: number,
    casterY: number,
    casterZ: number,
    succeeded: boolean,
  ): void {
    this.renderWorldHandle?.scene.playAbilityLabAction(
      action,
      casterX,
      casterY,
      casterZ,
      succeeded,
    );
  }

  /** 高亮一格地形；传 undefined 收起高亮。高度由渲染侧那份地形自己算。 */
  public setTerrainHighlight(cell?: { cellX: number; cellZ: number }): void {
    this.runtime.setTerrainHighlight(cell);
  }

  /** 建造幽灵：玩家正要放的那一件，吸附到网格上、按能不能放染色。传 undefined 收起。 */
  public setBuildPreview(state: BuildPreviewState | undefined): void {
    this.renderWorldHandle?.scene.setBuildPreview(state);
  }

  /** 蓄力时那条白色抛物线。和建造幽灵一样是一条每帧的状态命令。 */
  public setBallisticPreview(state: BallisticPreviewState | undefined): void {
    this.renderWorldHandle?.scene.setBallisticPreview(state);
  }

  public setSimpleCollisionVisible(visible: boolean): void {
    this.simpleCollisionVisible = visible;
    this.actorSnapshotTarget?.setSimpleCollisionVisible(visible);
    if (!visible) this.runtime.setPhysicsDebug(undefined);
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
    this.runtime.setWeather(weather);
  }

  public get weather(): WeatherType {
    return this.currentWeather;
  }

  public setTimeOfDay(timeOfDay: number, dayLengthSeconds: number): void {
    this.dayNightClock.applyServerTime(timeOfDay, dayLengthSeconds);
  }

  /**
   * 场景进出。渲染世界里的表现组件（落叶）靠它挂上／摘下自己的对象，
   * 和主线程那批场景组件的 `setActive` 是同一个语义。
   */
  public setSceneActive(active: boolean): void {
    // 状态记在渲染世界那一侧：`onEnter` 发生在加入房间**之前**，那时还没有场景
    // 组合，开关打在空处；`RenderWorldRuntime` 装上新组合时会把它补上去。
    this.runtime.setSceneActive(active);
  }

  public get timeOfDay(): number {
    return this.dayNightClock.timeOfDay;
  }

  /**
   * 这张地图的天气与时钟从头开始。
   *
   * 和换组合分开是因为它们的时机不同：换组合是每次都做的，而「重开时钟」只在真的
   * 换了一张地图时做——退回空场景不该把时刻拨回早上。
   */
  public resetEnvironment(definition?: SceneDefinition): void {
    this.currentWeather = DEFAULT_WEATHER;
    if (!definition) return;
    // 关掉昼夜或冻结时长度为 0，时刻停在 startHour。
    const dayNight = definition.environment.dayNight;
    this.dayNightClock.reset(
      dayNight.startHour,
      dayNight.enabled && !dayNight.paused ? dayNight.dayLengthSeconds : 0,
    );
  }

  /**
   * 接住新组合里属于**玩法**的那一半。
   *
   * 渲染那一半根本不经过这里：`SceneCompositionHost` 先让渲染世界按定义与种子
   * 自己建好（`renderCommands.loadRenderScene`），再把它递出来的三个口子交给
   * `createGameWorld`。这个方法收到的 `SceneComposition` 里因此没有一个 THREE 对象。
   */
  public adoptComposition(composition: SceneComposition): void {
    this.visualSystems = composition.visualSystems;
    this.actorSnapshotTarget = composition.actorSnapshotTarget;
    this.renderWorldHandle = composition.renderScene
      && composition.renderTransforms
      && composition.renderProxyIds
      ? {
        scene: composition.renderScene,
        transforms: composition.renderTransforms,
        proxyIds: composition.renderProxyIds,
      }
      : undefined;
    this.actorSnapshotTarget?.setSimpleCollisionVisible(this.simpleCollisionVisible);
    this.actorSnapshotTarget?.setTemperatureVisible(this.temperatureVisible);
  }

  private measureCanvas(): { width: number; height: number; pixelRatio: number } {
    return {
      width: Math.max(1, Math.floor(this.canvas.clientWidth || this.canvas.width)),
      height: Math.max(1, Math.floor(this.canvas.clientHeight || this.canvas.height)),
      pixelRatio: Math.min(window.devicePixelRatio || 1, 1.75),
    };
  }
}
