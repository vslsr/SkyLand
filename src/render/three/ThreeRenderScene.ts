import * as THREE from 'three';
import type { FillMaterialEnvironment } from '../../materials/createFillMaterial';
import type { OceanVisualDefinition } from '../../scenes/data/SceneDefinition';
import { createActorVisualModel } from '../../models/actors/createActorVisualModel';
import type {
  ActorVisualModel,
  SlimeLegVisualRig,
} from '../../models/actors/ActorVisualModel';
import { createPbfSlimeModel } from '../../models/actors/createPbfSlimeModel';
import {
  createLeggedSlimeModel,
  type LeggedSlimeRenderDefinition,
} from '../../models/actors/createLeggedSlimeModel';
import { createPlayerSlimeModel, createSlimePalette } from '../../models/playerSlime';
import {
  NULL_PROXY_ID,
  type GuidePathState,
  type GuidePathStyle,
  type MeshProxyDesc,
  type MeshProxyInfo,
  type PlayerProxyDesc,
  type ProxyId,
  type RenderScene,
  type SlimeSurfaceDragRay,
  type SlimeSurfaceDragState,
  toProxyId,
} from '../RenderScene';
import {
  readSlimeMotionParams,
  SLIME_MOTION_AT_REST,
  type SlimeMotionParams,
} from '../RenderSlimeMotion';
import {
  SLIME_DRAG_AT_REST,
  readSlimeDragParams,
  type SlimeDragParams,
} from '../RenderSlimeDrag';
import {
  createSlimeBiteParams,
  readSlimeBiteParams,
  type SlimeBiteParams,
} from '../RenderSlimeBite';
import {
  SLIME_GROUND_PROBE_AT_REST,
  readSlimeGroundProbeParams,
  type SlimeGroundProbeParams,
} from '../RenderSlimeLegs';
import type { RenderTransform, RenderTransformBuffer } from '../RenderTransformBuffer';
import { PARAM_SLIME_SPEED, PARAM_TEMPERATURE } from '../RenderVisualParams';
import { ThreeFireVisual } from './ThreeFireVisual';
import { ThreeGuidePathVisual } from './ThreeGuidePathVisual';
import { ThreeHybridSlimeVisual } from './ThreeHybridSlimeVisual';
import { ThreeSlimeLegVisual } from './ThreeSlimeLegVisual';
import { ThreeAttachmentVisual } from './ThreeAttachmentVisual';
import { ThreeDropRollVisual } from './ThreeDropRollVisual';
import { ThreeElasticTetherVisual } from './ThreeElasticTetherVisual';
import { ThreeMeshProxy } from './ThreeMeshProxy';
import {
  ThreeWaterMotionVisual,
  type WaterMotionMode,
} from './ThreeWaterMotionVisual';
import { ThreeSlimeAnimator } from './ThreeSlimeAnimator';
import {
  createDefaultSlimeSurfaceDragDefinition,
  ThreeSlimeSurfaceDrag,
} from './ThreeSlimeSurfaceDrag';

/**
 * `RenderScene` 的 Three.js 后端（路线图 第 1 步）。
 *
 * 现有的 Three 代码原样搬进来，帧率不变、画面不变。价值不在这一版实现，在
 * **盒子的接口**——它和以后 C++ 渲染器的接口是同一个。盒子里换成 GL 状态机
 * 那天，`ClientActorSystem` 一行都不用改。
 *
 * 这个类里没有一个 `Actor` 类型；它只认识 `ProxyId`。
 */

function createEmptyModel(name: string): ActorVisualModel {
  const root = new THREE.Group();
  const visualRoot = new THREE.Group();
  root.name = `${name}-root`;
  visualRoot.name = `${name}-visual`;
  root.add(visualRoot);
  return {
    root,
    visualRoot,
    length: 0,
    width: 0,
    simpleCollision: {
      shape: 'box',
      centerX: 0,
      centerZ: 0,
      halfWidth: 0,
      halfLength: 0,
      minimumY: 0,
      maximumY: 0,
      supportShape: 'box',
      supportHalfWidth: 0,
      supportHalfLength: 0,
    },
  };
}

function describeProxy(proxy: ThreeMeshProxy): MeshProxyInfo {
  return {
    id: proxy.id,
    length: proxy.length,
    width: proxy.width,
    interactionAnchorY: proxy.interactionAnchorY,
    simpleCollision: proxy.simpleCollision,
  };
}

function normalizeAngle(value: number): number {
  let angle = value;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

export class ThreeRenderScene implements RenderScene {
  /** 槽位即 ProxyId，回收后复用；空洞用 undefined 占位，保持下标稳定。 */
  private readonly proxies: (ThreeMeshProxy | undefined)[] = [];
  private readonly freeSlots: number[] = [];
  private readonly world: RenderTransform = { x: 0, y: 0, z: 0, yaw: 0 };
  private readonly parentWorld: RenderTransform = { x: 0, y: 0, z: 0, yaw: 0 };
  private simpleCollisionVisible = false;
  private temperatureMarkersVisible = false;
  /** 当前选中的交互目标；NULL_PROXY_ID 表示没有选中。 */
  private selectedInteractionProxy: ProxyId = NULL_PROXY_ID;
  /** 渲染世界自己的表现系统。它们只认识 ProxyId，不认识 Actor。 */
  private readonly fireVisual = new ThreeFireVisual();
  /** proxyId → 引导路径表现。只有引导 Actor 有，所以用 Map 而不是按槽位的数组。 */
  private readonly guidePaths = new Map<ProxyId, ThreeGuidePathVisual>();
  /** 样式在 spawn 时给定，实体等第一条带路点的命令到了再建——GuidePath 至少要 2 个路点。 */
  private readonly guidePathStyles = new Map<ProxyId, GuidePathStyle>();
  /** proxyId → 软体蒙皮表现。只有 PBF 史莱姆有，所以用 Map 而不是按槽位的数组。 */
  private readonly slimeVisuals = new Map<ProxyId, ThreeHybridSlimeVisual>();
  /** proxyId → 软体挤压动画。贴地的 `line-art-player-slime` 与长腿的都用它。 */
  private readonly slimeAnimators = new Map<ProxyId, ThreeSlimeAnimator>();
  /** proxyId → 骨骼腿的步态与 IK。只有 `line-art-legged-slime` 有。 */
  private readonly slimeLegs = new Map<ProxyId, ThreeSlimeLegVisual>();
  /** proxyId → 蒙皮拖拽。只有玩家 proxy 会建。 */
  private readonly slimeDrags = new Map<ProxyId, ThreeSlimeSurfaceDrag>();
  /** 逐帧复用的参数读出缓冲，避免每个史莱姆每帧分配一个对象。 */
  private readonly slimeMotion: SlimeMotionParams = { ...SLIME_MOTION_AT_REST };
  private readonly slimeDrag: SlimeDragParams = { ...SLIME_DRAG_AT_REST };
  private readonly slimeBite: SlimeBiteParams = createSlimeBiteParams();
  private readonly slimeGroundProbe: SlimeGroundProbeParams = { ...SLIME_GROUND_PROBE_AT_REST };
  /** 腿部步态每帧要读的世界 transform；和 world/parentWorld 一样是复用的读出缓冲。 */
  private readonly legWorld: RenderTransform = { x: 0, y: 0, z: 0, yaw: 0 };
  /** proxyId → 客户端波面浮动的模式。没有海的地图上这张表永远是空的。 */
  private readonly waterMotions = new Map<ProxyId, WaterMotionMode>();
  private readonly waterMotionVisual?: ThreeWaterMotionVisual;
  /** proxyId → 弹性拉伸 / 脱落翻滚。两者都只有弹性蘑菇那种模型才有。 */
  private readonly elasticTethers = new Map<ProxyId, ThreeElasticTetherVisual>();
  private readonly dropRolls = new Map<ProxyId, ThreeDropRollVisual>();
  private readonly attachmentVisual = new ThreeAttachmentVisual();

  public constructor(
    public readonly root: THREE.Group,
    private readonly environment: FillMaterialEnvironment,
    ocean?: OceanVisualDefinition,
  ) {
    this.waterMotionVisual = ocean ? new ThreeWaterMotionVisual(ocean) : undefined;
  }

  public createMeshProxy(desc: MeshProxyDesc): MeshProxyInfo {
    const model = desc.render
      ? createActorVisualModel(this.environment, desc.render)
      : createEmptyModel(desc.name);
    if (desc.render) {
      model.root.name = `${desc.name}-root`;
      model.visualRoot.name = `${desc.name}-visual`;
    }
    const proxy = this.#adopt(model);
    if (desc.interactionMarker) proxy.markers.attachInteraction(proxy.interactionAnchorY);
    if (desc.temperatureMarker) {
      proxy.markers.attachTemperature(proxy.temperatureAnchorX, proxy.interactionAnchorY, 0);
      proxy.markers.setTemperatureVisible(this.temperatureMarkersVisible);
    }
    if (desc.guidePath) this.guidePathStyles.set(proxy.id, desc.guidePath);
    if (desc.render?.model === 'line-art-pbf-slime' && model.pbfSlimeVisualRig) {
      this.slimeVisuals.set(
        proxy.id,
        new ThreeHybridSlimeVisual(model.pbfSlimeVisualRig, desc.render),
      );
    }
    if (desc.render?.model === 'line-art-legged-slime' && model.slimeLegVisualRig) {
      this.#adoptLegs(proxy.id, model.slimeLegVisualRig, desc.render);
    }
    // 没有海的地图上这两条表现不存在，模式给了也忽略。
    if (desc.waterMotion && this.waterMotionVisual) {
      this.waterMotions.set(proxy.id, desc.waterMotion);
    }
    // 这两项由模型自己产出的 rig 决定，不需要 desc 再说一遍：只有弹性蘑菇那种
    // 模型会建出这两套 rig，而它们正是原来那两个 System 会挑中的 Actor。
    if (model.elasticTetherRig) {
      this.elasticTethers.set(proxy.id, new ThreeElasticTetherVisual(proxy.id, model.elasticTetherRig));
    }
    if (model.dropRollRig) {
      this.dropRolls.set(proxy.id, new ThreeDropRollVisual(proxy.id, model.dropRollRig));
    }
    return describeProxy(proxy);
  }

  /**
   * 玩家史莱姆（本地与远端）。
   *
   * 玩家不是 Replica，但它的 proxy 必须和 Actor 的 proxy 落在同一张槽位表、
   * 同一段 SoA 里——`ProxyId` 是边界上唯一的标识，两套编号就没有边界可言了。
   */
  public createPlayerProxy(desc: PlayerProxyDesc): MeshProxyInfo {
    if (desc.render.model === 'line-art-player-slime') {
      const model = createPlayerSlimeModel(
        desc.render,
        desc.paletteSeed === undefined ? undefined : createSlimePalette(desc.paletteSeed),
      );
      model.root.name = desc.name;
      const proxy = this.#adopt(model);
      this.slimeAnimators.set(
        proxy.id,
        new ThreeSlimeAnimator(model, { referenceSpeed: desc.walkSpeed, shadow: model.shadow }),
      );
      return describeProxy(proxy);
    }
    if (desc.render.model === 'line-art-legged-slime') {
      const model = createLeggedSlimeModel(
        desc.render,
        desc.paletteSeed === undefined ? undefined : createSlimePalette(desc.paletteSeed),
      );
      const rig = model.slimeLegVisualRig;
      if (!rig) throw new Error(`骨骼腿史莱姆缺少 VisualRig：${desc.name}`);
      model.root.name = desc.name;
      const proxy = this.#adopt(model);
      this.#adoptLegs(proxy.id, rig, desc.render, desc.walkSpeed);
      return describeProxy(proxy);
    }
    const model = createPbfSlimeModel(desc.render);
    const rig = model.pbfSlimeVisualRig;
    if (!rig) throw new Error(`混合软体玩家史莱姆缺少 VisualRig：${desc.name}`);
    model.root.name = desc.name;
    const proxy = this.#adopt(model);
    const slime = new ThreeHybridSlimeVisual(rig, desc.render);
    this.slimeVisuals.set(proxy.id, slime);
    this.slimeDrags.set(proxy.id, new ThreeSlimeSurfaceDrag(
      rig,
      slime.simulation,
      desc.surfaceDrag ?? createDefaultSlimeSurfaceDragDefinition(desc.render.radius),
    ));
    return describeProxy(proxy);
  }

  /**
   * 长腿史莱姆的两套表现：身体的软体挤压和腿的步态。
   *
   * 身体复用 `ThreeSlimeAnimator`——它就是 `line-art-player-slime` 的那套软体，
   * 只是 `restHeightRatio` 给 0：中心停在髋点上，高度交给腿。身体阴影也不给，
   * 灰色接触阴影画在每个落脚点上。
   */
  #adoptLegs(
    id: ProxyId,
    rig: SlimeLegVisualRig,
    render: LeggedSlimeRenderDefinition,
    walkSpeed?: number,
  ): void {
    this.slimeAnimators.set(id, new ThreeSlimeAnimator(rig.softBody, {
      referenceSpeed: walkSpeed,
      restHeightRatio: 0,
    }));
    this.slimeLegs.set(id, new ThreeSlimeLegVisual(rig, render));
  }

  /** 分槽位、登记、挂进场景图。两个入口共用同一张槽位表。 */
  #adopt(model: ActorVisualModel): ThreeMeshProxy {
    const slot = this.freeSlots.pop() ?? this.proxies.length;
    const proxy = new ThreeMeshProxy(toProxyId(slot), model);
    this.proxies[slot] = proxy;
    proxy.setSimpleCollisionVisible(this.simpleCollisionVisible);
    this.root.add(proxy.root);
    return proxy;
  }

  public destroyMeshProxy(id: ProxyId): void {
    const proxy = this.proxies[id];
    if (!proxy) return;
    this.proxies[id] = undefined;
    this.freeSlots.push(id);
    this.fireVisual.forget(id);
    if (this.selectedInteractionProxy === id) this.selectedInteractionProxy = NULL_PROXY_ID;
    // 引导路径先摘：它的子树挂在 visualRoot 下，要赶在 disposeSubtree 之前
    // 自己收走（GuidePath 还持有一份共享光晕纹理的引用计数）。
    this.guidePaths.get(id)?.dispose();
    this.guidePaths.delete(id);
    this.guidePathStyles.delete(id);
    this.slimeDrags.get(id)?.dispose();
    this.slimeDrags.delete(id);
    this.slimeVisuals.delete(id);
    this.slimeAnimators.delete(id);
    this.slimeLegs.delete(id);
    this.waterMotions.delete(id);
    this.elasticTethers.delete(id);
    this.dropRolls.delete(id);
    this.attachmentVisual.forget(id);
    proxy.dispose();
  }

  /** 渲染侧查找引导路径表现。 */
  public resolveGuidePath(id: ProxyId): ThreeGuidePathVisual | undefined {
    return this.guidePaths.get(id);
  }

  /** 渲染侧查找。只有渲染世界内部（表现 System、拾取、调试可视化）能调。 */
  public resolve(id: ProxyId): ThreeMeshProxy | undefined {
    return id >= 0 ? this.proxies[id] : undefined;
  }

  public liveProxies(): readonly ThreeMeshProxy[] {
    return this.proxies.filter((proxy): proxy is ThreeMeshProxy => proxy !== undefined);
  }

  /**
   * 把这一帧的 SoA 兑现到 Three 的场景图。
   *
   * 边界上传的是**世界坐标**；这里从已插值的父/子世界坐标反算渲染局部坐标，
   * 使 Three 层级的最终世界位置严格等于权威插值结果，而不是重新插值局部坐标。
   * 这段数学是 Three 场景图的需求，所以它属于渲染侧，不属于 Game World。
   */
  public submitTransforms(transforms: RenderTransformBuffer): void {
    for (const proxy of this.proxies) {
      if (!proxy) continue;
      transforms.readTransform(proxy.id, this.world);
      const parentId = transforms.readParent(proxy.id);
      const parent = parentId >= 0 ? this.proxies[parentId] : undefined;
      // Actor 根节点只能挂到父 proxy 的权威 root，禁止经过带摇晃/倾斜的 visualRoot。
      const renderParent = parent?.root ?? this.root;
      if (proxy.root.parent !== renderParent) renderParent.add(proxy.root);
      if (!parent) {
        proxy.root.position.set(this.world.x, this.world.y, this.world.z);
        proxy.root.rotation.y = this.world.yaw;
        continue;
      }
      transforms.readTransform(parent.id, this.parentWorld);
      const deltaX = this.world.x - this.parentWorld.x;
      const deltaZ = this.world.z - this.parentWorld.z;
      const sinYaw = Math.sin(this.parentWorld.yaw);
      const cosYaw = Math.cos(this.parentWorld.yaw);
      proxy.root.position.set(
        cosYaw * deltaX - sinYaw * deltaZ,
        this.world.y - this.parentWorld.y,
        sinYaw * deltaX + cosYaw * deltaZ,
      );
      proxy.root.rotation.y = normalizeAngle(this.world.yaw - this.parentWorld.yaw);
    }
  }

  /**
   * 驱动渲染世界自己的表现动画。读的是刚翻面的参数段，写的是自己持有的 rig，
   * 全程不经过任何 Actor。
   */
  public updateVisuals(
    transforms: RenderTransformBuffer,
    deltaSeconds: number,
    elapsedSeconds: number,
  ): void {
    const live = this.liveProxies();
    // 顺序照搬搬迁之前 Actor 世界里的那一段：波动先算（附着要读父级摆好的
    // visualRoot），附着居中，弹性拉伸在脱落翻滚之前（翻滚会覆盖它摆好的姿态）。
    if (this.waterMotionVisual) {
      for (const [id, mode] of this.waterMotions) {
        const proxy = this.resolve(id);
        if (!proxy) continue;
        this.waterMotionVisual.update(proxy, mode, transforms, deltaSeconds, elapsedSeconds);
      }
    }
    this.attachmentVisual.update(live, (id) => this.resolve(id), transforms);
    for (const tether of this.elasticTethers.values()) {
      tether.update(transforms, deltaSeconds, elapsedSeconds);
    }
    for (const drop of this.dropRolls.values()) drop.update(transforms);
    this.fireVisual.update(live, transforms, deltaSeconds, elapsedSeconds);
    for (const proxy of live) {
      proxy.markers.setTemperature(transforms.readParam(proxy.id, PARAM_TEMPERATURE));
    }
    for (const guide of this.guidePaths.values()) guide.update(deltaSeconds);
    // 权威 yaw 取的是 submitTransforms 刚摆好的 root 角度：外壳要抵消的正是
    // 「root 这一级实际被转了多少」，父子情况下那已经是相对 yaw。
    for (const [id, slime] of this.slimeVisuals) {
      const proxy = this.resolve(id);
      if (!proxy) continue;
      // 外力必须赶在这一帧求解之前写进去，否则复制过来的形变会晚一帧，
      // 看上去就是别人的史莱姆比他的鼠标慢半拍。
      this.slimeDrags.get(id)?.applyReplicated(
        readSlimeDragParams(transforms, id, this.slimeDrag),
      );
      // 咬住的尖是静止外形的一项，不走拖拽那条抓取/权重的路；几张嘴就是几个向量。
      slime.simulation.setBiteTips(readSlimeBiteParams(transforms, id, this.slimeBite));
      slime.update(
        deltaSeconds,
        elapsedSeconds,
        proxy.root.rotation.y,
        readSlimeMotionParams(transforms, id, this.slimeMotion),
      );
    }
    // 腿排在身体之前：它解出的水平速率是身体挤压动画的输入。两者写的不是同一个
    // 节点（腿写 `bodyRoot` 的高度，软体在 `bodyRoot` 下面原地挤压），所以这个
    // 顺序只为了那一个标量。
    for (const [id, legs] of this.slimeLegs) {
      if (!this.resolve(id)) continue;
      legs.update(
        deltaSeconds,
        transforms.readTransform(id, this.legWorld),
        readSlimeMotionParams(transforms, id, this.slimeMotion),
        readSlimeGroundProbeParams(transforms, id, this.slimeGroundProbe),
      );
    }
    for (const [id, animator] of this.slimeAnimators) {
      // 服务端推着走的 Replica 在参数段里速度是 0（它不复制运动演示），
      // 但腿已经从它被摆到哪儿差分出了速率——身体的挤压该跟着那一个走。
      const legs = this.slimeLegs.get(id);
      animator.update(
        deltaSeconds,
        elapsedSeconds,
        legs ? legs.presentationSpeed : transforms.readParam(id, PARAM_SLIME_SPEED),
      );
    }
  }

  /**
   * 蒙皮拖拽。指针、相机和外壳全在渲染这一侧，所以这三个方法是渲染世界内部调用，
   * 不是边界；玩法侧只会经由控制器收到「拖拽开始/结束」一个布尔。
   */
  public beginSlimeSurfaceDrag(id: ProxyId, ray: SlimeSurfaceDragRay): boolean {
    return this.slimeDrags.get(id)?.beginDrag(ray) ?? false;
  }

  public updateSlimeSurfaceDrag(id: ProxyId, ray: SlimeSurfaceDragRay): boolean {
    return this.slimeDrags.get(id)?.updateDrag(ray) ?? false;
  }

  public endSlimeSurfaceDrag(id: ProxyId): void {
    this.slimeDrags.get(id)?.endDrag();
  }

  public isSlimeSurfaceDragging(id: ProxyId): boolean {
    return this.slimeDrags.get(id)?.isDragging ?? false;
  }

  /**
   * 取出本地玩家这一次手势，供玩法侧发给房间。射线不跨边界，这六个本地坐标要：
   * 其他客户端拿到它们才能在自己的求解器上重放同一次形变。
   */
  public readSlimeSurfaceDrag(id: ProxyId, out: SlimeSurfaceDragState): boolean {
    return this.slimeDrags.get(id)?.captureState(out) ?? false;
  }

  /** 渲染侧查找软体表现（能力实验室与测试用）。 */
  public resolveSlimeVisual(id: ProxyId): ThreeHybridSlimeVisual | undefined {
    return this.slimeVisuals.get(id);
  }

  /**
   * 应用一次引导路径状态。`pathChanged` 由玩法侧按 pathRevision 判断——
   * 路径与索引必须在同一次调用里落地，拆开会让引导线闪回起点。
   */
  public setGuidePath(id: ProxyId, state: GuidePathState, pathChanged: boolean): void {
    let visual = this.guidePaths.get(id);
    if (!visual) {
      const style = this.guidePathStyles.get(id);
      const proxy = this.resolve(id);
      // GuidePath 至少要 2 个路点，所以实体等第一条带路点的命令才建。
      // 顺带避开了「出生先建一次几何、首次 sync 又重建一次」的浪费。
      if (!style || !proxy || state.points.length < 2) return;
      visual = new ThreeGuidePathVisual(`${proxy.root.name}-guide-path`, {
        points: state.points,
        curve: state.curve,
        ...style,
      });
      this.guidePaths.set(id, visual);
      // 挂 visualRoot 是有意的：船上的引导线要跟着船体波动一起摇。
      proxy.visualRoot.add(visual.guide.root);
      visual.apply(state, false);
      return;
    }
    visual.apply(state, pathChanged);
  }

  /** 线宽是像素单位；必须在 beforeRender 拿 resize 之后的真实画布尺寸。 */
  public setGuidePathResolution(width: number, height: number): void {
    for (const guide of this.guidePaths.values()) guide.setResolution(width, height);
  }

  /**
   * 选中哪一个交互目标。`NULL_PROXY_ID` 表示没有选中——生成物件带
   * InteractableComponent 却没有 proxy，所以「目标没有 proxyId」必须是合法输入。
   */
  public setInteractionMarker(id: ProxyId, label: string): void {
    this.selectedInteractionProxy = id;
    for (const proxy of this.proxies) {
      if (!proxy?.markers.hasInteraction) continue;
      const selected = proxy.id === id && label.length > 0;
      proxy.markers.setInteraction(label, selected);
    }
  }

  /** 温度牌的全局开关。和 setSimpleCollisionVisible 一样是渲染世界自己的状态。 */
  public setTemperatureMarkersVisible(visible: boolean): void {
    this.temperatureMarkersVisible = visible;
    for (const proxy of this.proxies) proxy?.markers.setTemperatureVisible(visible);
  }

  public get isTemperatureMarkersVisible(): boolean {
    return this.temperatureMarkersVisible;
  }

  /** 让所有世界 UI 正对相机。由 beforeRender 驱动——它拿得到相机。 */
  public faceCameras(camera: THREE.Camera): void {
    for (const proxy of this.proxies) proxy?.markers.faceCamera(camera);
  }

  /** 简易碰撞盒的可视化开关。是渲染世界自己的状态，遍历不经过任何 Actor。 */
  public setSimpleCollisionVisible(visible: boolean): void {
    this.simpleCollisionVisible = visible;
    for (const proxy of this.proxies) proxy?.setSimpleCollisionVisible(visible);
  }

  public dispose(): void {
    for (const guide of this.guidePaths.values()) guide.dispose();
    this.guidePaths.clear();
    this.guidePathStyles.clear();
    for (const drag of this.slimeDrags.values()) drag.dispose();
    this.slimeDrags.clear();
    this.slimeVisuals.clear();
    this.slimeAnimators.clear();
    this.waterMotions.clear();
    this.elasticTethers.clear();
    this.dropRolls.clear();
    for (const proxy of this.proxies) proxy?.dispose();
    this.proxies.length = 0;
    this.freeSlots.length = 0;
  }
}
