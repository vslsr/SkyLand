import * as THREE from 'three';
import { frameTimeline } from '../../platform/index';
import type {
  AbilityLabAction,
  AbilityLabViewState,
} from '../../abilities/lab/AbilityLabSimulation';
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
  type BallisticPreviewState,
  type BuildPreviewState,
  type GuidePathState,
  type GuidePathStyle,
  type MeshProxyDesc,
  type PlayerProxyDesc,
  type ProxyId,
  type RenderScene,
  type SlimeSurfaceDragListener,
  type SlimeSurfaceDragRay,
} from '../RenderScene';
import {
  readSlimeMotionParams,
  SLIME_MOTION_AT_REST,
  type SlimeMotionParams,
} from '../RenderSlimeMotion';
import type { RenderInstanceBuffer } from '../RenderInstanceBuffer';
import { EMPTY_ARCHETYPE_TABLE, type ArchetypeTable } from '../propInstanceLayout';
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
import {
  PARAM_HEALTH_DEATH_REVISION,
  PARAM_SLIME_SPEED,
  PARAM_TEMPERATURE,
} from '../RenderVisualParams';
import { ThreeFireVisual } from './ThreeFireVisual';
import { ThreePointLightVisual } from './ThreePointLightVisual';
import { ThreeGuidePathVisual } from './ThreeGuidePathVisual';
import { ThreeArrowShotVisual } from './ThreeArrowShotVisual';
import { ThreeBallisticPreviewVisual } from './ThreeBallisticPreviewVisual';
import { ThreeHealthPopupVisual } from './ThreeHealthPopupVisual';
import { ThreeHybridSlimeVisual } from './ThreeHybridSlimeVisual';
import { ThreeAbilityLabVisual } from './ThreeAbilityLabVisual';
import { ThreeFruitBatchVisual } from './ThreeFruitBatchVisual';
import { ThreeHighCountBatchVisual } from './ThreeHighCountBatchVisual';
import { ThreeSlimeLegVisual } from './ThreeSlimeLegVisual';
import { ThreeAttachmentVisual } from './ThreeAttachmentVisual';
import { ThreeBuildPreviewVisual } from './ThreeBuildPreviewVisual';
import { ThreeContainerLidVisual } from './ThreeContainerLidVisual';
import { ThreeWoodBowVisual } from './ThreeWoodBowVisual';
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

function normalizeAngle(value: number): number {
  let angle = value;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

export class ThreeRenderScene implements RenderScene {
  /** 槽位即 ProxyId，回收后复用；空洞用 undefined 占位，保持下标稳定。 */
  private readonly proxies: (ThreeMeshProxy | undefined)[] = [];
  private readonly world: RenderTransform = { x: 0, y: 0, z: 0, yaw: 0 };
  private readonly parentWorld: RenderTransform = { x: 0, y: 0, z: 0, yaw: 0 };
  private simpleCollisionVisible = false;
  private temperatureMarkersVisible = false;
  /** 当前选中的交互目标；NULL_PROXY_ID 表示没有选中。 */
  private selectedInteractionProxy: ProxyId = NULL_PROXY_ID;
  /** 当前悬停高亮的目标与它的包围盒。两者都是渲染世界自己的状态。 */
  private hoveredProxy: ProxyId = NULL_PROXY_ID;
  private hoverHelper?: THREE.BoxHelper;
  /** 渲染世界自己的表现系统。它们只认识 ProxyId，不认识 Actor。 */
  private readonly fireVisual = new ThreeFireVisual();
  /**
   * 篝火与灯把周围点亮的那一半。它写的是**全场共享的环境 uniform**，
   * 而不是某个 proxy 的 rig——地面、草叶、别的物件都要被同一堆火染暖。
   */
  private readonly pointLights = new ThreePointLightVisual();
  /**
   * 上一帧的机位，`beforeRender` 抄下来的。
   *
   * 点光源要按「离视点多近」挑，而 `updateVisuals` 手上没有相机——相机是
   * 渲染循环自己的东西，它只在 `beforeRender` 那一步递进来。差的这一帧对
   * 「最近的四盏是哪四盏」没有可见影响：换选中的那一瞬间，被换掉的那盏本来
   * 就在半径边缘。
   */
  private readonly viewPosition = new THREE.Vector3();
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
  /** 上一次回报出去的拖拽状态，用来在松手那一下只发一次通知。 */
  private readonly reportedSlimeDrag = new Map<ProxyId, boolean>();
  /** 回报用的那一份，逐帧复用不分配。 */
  private readonly slimeDragReport = {
    id: NULL_PROXY_ID as ProxyId, dragging: false,
    contactX: 0, contactY: 0, contactZ: 0, pullX: 0, pullY: 0, pullZ: 0,
  };
  private slimeDragListener?: SlimeSurfaceDragListener;
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
  private readonly containerLids = new Map<ProxyId, ThreeContainerLidVisual>();
  /** proxyId → 拉弓的形变。只有手上那把木弓有：地上那把不会被拉开。 */
  private readonly woodBows = new Map<ProxyId, ThreeWoodBowVisual>();
  private readonly attachmentVisual = new ThreeAttachmentVisual();
  /** 建造幽灵。不是 proxy：没有槽位，只是一个跟着指针走的半透明模型。 */
  private readonly buildPreview = new ThreeBuildPreviewVisual();
  /**
   * 伤害 / 治疗飘字。同样不是 proxy——它挂在世界坐标上，和挨打的那个东西
   * 有没有 proxy 无关，池子大小固定，见 `ThreeHealthPopupVisual`。
   *
   * **第一条飘字到了才建**：一整池牌子各带一块离屏画布，而绝大多数场景
   * （大厅背后那一片、纯观察用的地图）一条飘字都不会有。
   */
  private healthPopups?: ThreeHealthPopupVisual;
  /** 蓄力时那条白色抛物线。同样按需建，见 `setBallisticPreview`。 */
  private ballisticPreview?: ThreeBallisticPreviewVisual;
  /** 飞在空中的那几支箭。第一箭射出去才建，见 `spawnArrowShot`。 */
  private arrowShots?: ThreeArrowShotVisual;
  /**
   * 能力实验室的表现（引擎迁移路线图 第 3 步）。
   *
   * 它以前住在主线程：`AbilityLabSceneComponent` 先 `getActorRenderProxy` 拿到活的
   * proxy，再把 rig 交给一个主线程的视觉系统。那是玩法侧最后一处**递出活对象**。
   *
   * 现在整套动画在这一侧，玩法侧只发三条命令：绑谁、这一帧什么状态、放一次技能。
   * 按需建——绝大多数地图没有能力实验室。
   */
  private abilityLab?: ThreeAbilityLabVisual;
  private abilityLabState?: AbilityLabViewState;
  private readonly abilityLabCaster = new THREE.Vector3();

  /**
   * 合批内容的两层实例化网格（引擎迁移路线图 第 3 步）。
   *
   * 这两个曾经归 `ClientActorSystem` 建、由它每帧 `sync` 进场景图——一个玩法类
   * 握着 `InstancedMesh`。它们读的本来就只是 `RenderInstanceBuffer` 里的定长记录
   * （原型下标、几个状态位、位置与数量），不认识 Actor，所以整个属于这一侧。
   *
   * 原型表两侧各自从同一份场景定义建（`createArchetypeTable`），不走通道。
   */
  private readonly highCountBatches: ThreeHighCountBatchVisual;
  private readonly fruitBatches: ThreeFruitBatchVisual;
  private readonly archetypeOrder: readonly string[];
  /** 玩法侧这一帧交上来的两段实例记录。没交过就是 undefined——这张图没有合批内容。 */
  private propInstances?: RenderInstanceBuffer;
  private fruitInstances?: RenderInstanceBuffer;

  public constructor(
    public readonly root: THREE.Group,
    private readonly environment: FillMaterialEnvironment,
    ocean?: OceanVisualDefinition,
    /**
     * 合批内容的原型表。默认是空表——没有掉落堆和果树的地图（以及绝大多数用例）
     * 本来就不需要它。两侧各自从同一份场景定义建，见 `createArchetypeTable`。
     */
    archetypes: ArchetypeTable = EMPTY_ARCHETYPE_TABLE,
  ) {
    this.archetypeOrder = archetypes.order;
    this.highCountBatches = new ThreeHighCountBatchVisual(environment, archetypes.byId);
    this.fruitBatches = new ThreeFruitBatchVisual(environment);
    this.waterMotionVisual = ocean ? new ThreeWaterMotionVisual(ocean) : undefined;
  }

  /**
   * 蓄力时那条白色抛物线。和飘字一样第一次要用的时候才建：绝大多数场景
   * 一辈子也不会有人在里面拉弓。
   */
  public setBallisticPreview(state: BallisticPreviewState | undefined): void {
    if (!state && !this.ballisticPreview) return;
    if (!this.ballisticPreview) {
      this.ballisticPreview = new ThreeBallisticPreviewVisual();
      this.root.add(this.ballisticPreview.root);
    }
    this.ballisticPreview.setState(state);
  }

  public spawnArrowShot(state: BallisticPreviewState): void {
    if (!this.arrowShots) {
      this.arrowShots = new ThreeArrowShotVisual(this.environment);
      this.root.add(this.arrowShots.root);
    }
    this.arrowShots.spawn(state);
  }

  public spawnHealthPopup(x: number, y: number, z: number, amount: number): void {
    if (!this.healthPopups) {
      this.healthPopups = new ThreeHealthPopupVisual();
      this.root.add(this.healthPopups.root);
    }
    this.healthPopups.spawn(x, y, z, amount);
  }

  /**
   * 这一帧的合批内容就绪。
   *
   * 和 `submitTransforms` 同一个形状：参数是**那段字节**，不是画出来的东西。
   * 上 worker 之后同一个 SAB 一开始就在两侧，这条命令因此不带载荷。
   */
  public submitInstances(props: RenderInstanceBuffer, fruit: RenderInstanceBuffer): void {
    this.propInstances = props;
    this.fruitInstances = fruit;
  }

  public createMeshProxy(id: ProxyId, desc: MeshProxyDesc): void {
    const model = desc.render
      ? createActorVisualModel(this.environment, desc.render)
      : createEmptyModel(desc.name);
    if (desc.render) {
      model.root.name = `${desc.name}-root`;
      model.visualRoot.name = `${desc.name}-visual`;
    }
    const proxy = this.#adopt(id, model);
    if (desc.interactionMarker) proxy.markers.attachInteraction(proxy.interactionAnchorY);
    if (desc.temperatureMarker) {
      proxy.markers.attachTemperature(proxy.temperatureAnchorX, proxy.interactionAnchorY, 0);
      proxy.markers.setTemperatureVisible(this.temperatureMarkersVisible);
    }
    if (desc.guidePath) this.guidePathStyles.set(proxy.id, desc.guidePath);
    if (desc.pointLight) this.pointLights.register(proxy.id, desc.pointLight);
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
    if (model.containerLidRig) {
      this.containerLids.set(proxy.id, new ThreeContainerLidVisual(proxy.id, model.containerLidRig));
    }
    if (model.woodBowRig) {
      this.woodBows.set(proxy.id, new ThreeWoodBowVisual(proxy.id, model.woodBowRig));
    }
  }

  /**
   * 玩家史莱姆（本地与远端）。
   *
   * 玩家不是 Replica，但它的 proxy 必须和 Actor 的 proxy 落在同一张槽位表、
   * 同一段 SoA 里——`ProxyId` 是边界上唯一的标识，两套编号就没有边界可言了。
   */
  public createPlayerProxy(id: ProxyId, desc: PlayerProxyDesc): void {
    if (desc.render.model === 'line-art-player-slime') {
      const model = createPlayerSlimeModel(
        desc.render,
        desc.paletteSeed === undefined ? undefined : createSlimePalette(desc.paletteSeed),
      );
      model.root.name = desc.name;
      const proxy = this.#adopt(id, model);
      this.slimeAnimators.set(
        proxy.id,
        new ThreeSlimeAnimator(model, { referenceSpeed: desc.walkSpeed, shadow: model.shadow }),
      );
      return;
    }
    if (desc.render.model === 'line-art-legged-slime') {
      const model = createLeggedSlimeModel(
        desc.render,
        desc.paletteSeed === undefined ? undefined : createSlimePalette(desc.paletteSeed),
      );
      const rig = model.slimeLegVisualRig;
      if (!rig) throw new Error(`骨骼腿史莱姆缺少 VisualRig：${desc.name}`);
      model.root.name = desc.name;
      const proxy = this.#adopt(id, model);
      this.#adoptLegs(proxy.id, rig, desc.render, desc.walkSpeed);
      return;
    }
    const model = createPbfSlimeModel(desc.render);
    const rig = model.pbfSlimeVisualRig;
    if (!rig) throw new Error(`混合软体玩家史莱姆缺少 VisualRig：${desc.name}`);
    model.root.name = desc.name;
    const proxy = this.#adopt(id, model);
    const slime = new ThreeHybridSlimeVisual(rig, desc.render);
    this.slimeVisuals.set(proxy.id, slime);
    this.slimeDrags.set(proxy.id, new ThreeSlimeSurfaceDrag(
      rig,
      slime.simulation,
      desc.surfaceDrag ?? createDefaultSlimeSurfaceDragDefinition(desc.render.radius),
    ));
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

  /**
   * 在调用方给的槽位上登记并挂进场景图。
   *
   * 槽位不再由这里分配：那需要一个返回值，而返回值过不了线程边界。
   * 分配在 `RenderProxyTable`（Game World 那一侧），两个入口共用它那一张表。
   */
  #adopt(id: ProxyId, model: ActorVisualModel): ThreeMeshProxy {
    const proxy = new ThreeMeshProxy(id, model);
    this.proxies[id] = proxy;
    proxy.setSimpleCollisionVisible(this.simpleCollisionVisible);
    this.root.add(proxy.root);
    return proxy;
  }

  public destroyMeshProxy(id: ProxyId): void {
    const proxy = this.proxies[id];
    if (!proxy) return;
    this.proxies[id] = undefined;
    this.fireVisual.forget(id);
    this.pointLights.forget(id);
    if (this.selectedInteractionProxy === id) this.selectedInteractionProxy = NULL_PROXY_ID;
    // 引导路径先摘：它的子树挂在 visualRoot 下，要赶在 disposeSubtree 之前
    // 自己收走（GuidePath 还持有一份共享光晕纹理的引用计数）。
    this.guidePaths.get(id)?.dispose();
    this.guidePaths.delete(id);
    this.guidePathStyles.delete(id);
    this.slimeDrags.get(id)?.dispose();
    this.slimeDrags.delete(id);
    // proxy 没了，拖拽链路当然也断了。不补这一条，控制器会一直以为自己还拖着。
    this.#reportSlimeSurfaceDrag(id, false);
    this.reportedSlimeDrag.delete(id);
    this.slimeVisuals.delete(id);
    this.slimeAnimators.delete(id);
    this.slimeLegs.delete(id);
    this.waterMotions.delete(id);
    this.elasticTethers.delete(id);
    this.dropRolls.delete(id);
    this.containerLids.delete(id);
    this.woodBows.delete(id);
    this.attachmentVisual.forget(id);
    proxy.dispose();
  }

  /**
   * 建造幽灵。每帧一条命令；模型按 `pieceId` 缓存，换件才重建。
   * 挂在渲染世界的根下，不挂在任何 proxy 下——它谁的孩子都不是。
   */
  public setBuildPreview(state: BuildPreviewState | undefined): void {
    this.buildPreview.apply(state, this.environment, this.root);
  }

  /** 幽灵此刻画没画出来（测试与调试用）。 */
  public get isBuildPreviewVisible(): boolean {
    return this.buildPreview.visible;
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
    // 悬停盒跟着目标走。放在最前是因为它读的是上一帧摆好的世界矩阵，
    // 和玩法侧原来在 sim-colliders 里调 hoverHelper.update() 的时机等价。
    this.hoverHelper?.update();
    // 合批内容排在最前：它读的是玩法侧刚写完的那段实例记录，和 transform 翻面
    // 是同一个 tick 的。挂载按需——没有合批内容的地图不会多出两层空节点。
    if (this.propInstances && this.fruitInstances) {
      frameTimeline.measure('render-batches', () => {
        this.highCountBatches.sync(this.propInstances!, this.archetypeOrder);
        this.fruitBatches.sync(this.fruitInstances!);
        if (this.fruitBatches.instanceCount > 0 && !this.fruitBatches.root.parent) {
          this.root.add(this.fruitBatches.root);
        }
        if (this.highCountBatches.root.children.length > 0 && !this.highCountBatches.root.parent) {
          this.root.add(this.highCountBatches.root);
        }
      });
    }
    if (this.abilityLab && this.abilityLabState) {
      this.abilityLab.update(
        deltaSeconds,
        elapsedSeconds,
        this.abilityLabState,
        this.abilityLabCaster,
      );
    }
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
    for (const lid of this.containerLids.values()) lid.update(transforms, deltaSeconds);
    for (const bow of this.woodBows.values()) bow.update(transforms, deltaSeconds);
    this.fireVisual.update(live, transforms, deltaSeconds, elapsedSeconds);
    // 光紧跟着火焰：两者读的是同一帧的字节，用的是同一条平滑时间常数，
    // 所以火苗矮下去的同时地面上的光晕也跟着收。
    this.pointLights.update(
      transforms,
      deltaSeconds,
      elapsedSeconds,
      this.viewPosition,
      this.environment.runtime,
    );
    for (const proxy of live) {
      proxy.markers.setTemperature(transforms.readParam(proxy.id, PARAM_TEMPERATURE));
    }
    for (const guide of this.guidePaths.values()) guide.update(deltaSeconds);
    // 飘字和别的表现一样按渲染帧走：玩法侧只在血量变的那一帧发一条命令。
    this.healthPopups?.update(deltaSeconds);
    // 箭同理：弹道在射出去那一刻就定了，这里只是按渲染帧把它走完。
    this.arrowShots?.update(deltaSeconds);
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
        // 死亡计数：变了就踢一次摊开，塌到百分之几由这一侧自己积分。
        transforms.readParam(id, PARAM_HEALTH_DEATH_REVISION),
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
        transforms.readParam(id, PARAM_HEALTH_DEATH_REVISION),
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
   * 蒙皮拖拽的三条命令，外加一条**反向通知**。
   *
   * 「这一次按下有没有抓住外壳」的判据在这一侧：命中测试打的是每帧被求解器改写的
   * 软体外壳网格，玩法侧根本没有那份几何。所以 `beginSlimeSurfaceDrag` 曾经
   * **有返回值**——那是这条边界上最后一次「等对面回话」。
   *
   * 现在改成：命令照发（返回 `void`），抓没抓住由这一侧经
   * `setSlimeSurfaceDragListener` 回报。单线程下这条通知在 `beginDrag` 里同步就发了，
   * 所以行为和以前逐帧一致；上 worker 之后它晚一帧到，而按下那一帧指针还没动过，
   * 相机轨道那一帧攒下的量是零。
   */
  public beginSlimeSurfaceDrag(id: ProxyId, ray: SlimeSurfaceDragRay): void {
    const drag = this.slimeDrags.get(id);
    if (!drag) return;
    drag.beginDrag(ray);
    this.#reportSlimeSurfaceDrag(id, drag.isDragging);
  }

  /**
   * 命中与否只影响这一侧：拖不动就是不动，没什么可回话的。
   *
   * 但**手势变了要回报**：拉扯量是这一步算出来的，而玩法侧要把它上报给房间。
   * 这条调用的节奏就是手势本身的节奏（指针动一次、每帧一次），不需要额外的扫描。
   */
  public updateSlimeSurfaceDrag(id: ProxyId, ray: SlimeSurfaceDragRay): void {
    const drag = this.slimeDrags.get(id);
    if (!drag) return;
    drag.updateDrag(ray);
    this.#reportSlimeSurfaceDrag(id, drag.isDragging);
  }

  public endSlimeSurfaceDrag(id: ProxyId): void {
    const drag = this.slimeDrags.get(id);
    if (!drag) return;
    drag.endDrag();
    this.#reportSlimeSurfaceDrag(id, drag.isDragging);
  }

  /**
   * 谁来收这条反向通知。同一时刻只有一个拖拽控制器（本地玩家那一个），
   * 所以是「设一个」而不是「订阅一堆」——设与清都返回 `void`，
   * 上 worker 之后这个监听器留在主线程那一侧的代理上，不跟着报文走。
   */
  public setSlimeSurfaceDragListener(listener?: SlimeSurfaceDragListener): void {
    this.slimeDragListener = listener;
  }

  public isSlimeSurfaceDragging(id: ProxyId): boolean {
    return this.slimeDrags.get(id)?.isDragging ?? false;
  }

  /**
   * 回报一次拖拽状态。
   *
   * 拖着的时候**每帧都报**：手势本身（六个本地坐标）要上行给房间，其他客户端才
   * 重放得出同一次形变。曾经这一步是玩法侧回头调 `readSlimeSurfaceDrag`——
   * 那是一次跨线程阻塞查询。改成回报之后，收报的一侧把最后一次缓存下来就够了。
   * 没在拖的时候只在状态翻转那一下报一次。
   */
  #reportSlimeSurfaceDrag(id: ProxyId, dragging: boolean): void {
    if (!dragging && this.reportedSlimeDrag.get(id) === false) return;
    this.reportedSlimeDrag.set(id, dragging);
    if (!this.slimeDragListener) return;
    const report = this.slimeDragReport;
    report.id = id;
    report.dragging = dragging;
    if (!dragging || !this.slimeDrags.get(id)?.captureState(report)) {
      report.contactX = 0; report.contactY = 0; report.contactZ = 0;
      report.pullX = 0; report.pullY = 0; report.pullZ = 0;
    }
    this.slimeDragListener(report);
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
   *
   * `opacity` 是交互提示的淡入淡出进度，只落在选中的那一块牌子上：没选中的牌子
   * 本来就不可见，跟着每帧变一遍不透明度是白写。
   */
  public setInteractionMarker(id: ProxyId, label: string, opacity = 1): void {
    this.selectedInteractionProxy = id;
    for (const proxy of this.proxies) {
      if (!proxy?.markers.hasInteraction) continue;
      const selected = proxy.id === id && label.length > 0;
      proxy.markers.setInteraction(label, selected, selected ? opacity : 1);
    }
  }

  /**
   * 悬停高亮。
   *
   * 这个包围盒以前由 `ClientActorSystem` 自己 `new THREE.BoxHelper(...)`——它得先
   * `resolve()` 拿到活的 proxy 才建得出来，而**递出一个活对象是线程边界过不去的**。
   * 现在玩法侧只发一个 `ProxyId`（没有选中就是 `NULL_PROXY_ID`），盒子在这一侧建、
   * 在这一侧释放，和 `setInteractionMarker` 是同一个套路。
   */
  public setAbilityLabTarget(id: ProxyId): void {
    if (id === NULL_PROXY_ID) {
      this.abilityLab?.reset();
      this.abilityLab?.unbindTarget();
      this.abilityLabState = undefined;
      return;
    }
    const proxy = this.proxies[id];
    if (!proxy) return;
    if (!this.abilityLab) {
      this.abilityLab = new ThreeAbilityLabVisual();
      this.root.add(this.abilityLab.root);
    }
    // rig 缺失在这一侧当场报错：玩法侧看不见 rig，也就判断不了。
    this.abilityLab.bindTarget(proxy);
    this.abilityLab.reset();
  }

  public setAbilityLabState(
    state: AbilityLabViewState | undefined,
    casterX: number,
    casterY: number,
    casterZ: number,
  ): void {
    this.abilityLabState = state;
    this.abilityLabCaster.set(casterX, casterY, casterZ);
  }

  public playAbilityLabAction(
    action: AbilityLabAction,
    casterX: number,
    casterY: number,
    casterZ: number,
    succeeded: boolean,
  ): void {
    if (!this.abilityLab) return;
    if (action === 'reset') {
      this.abilityLab.reset();
      return;
    }
    this.abilityLabCaster.set(casterX, casterY, casterZ);
    this.abilityLab.play(action, this.abilityLabCaster, succeeded);
  }

  public setHoveredProxy(id: ProxyId): void {
    if (id === this.hoveredProxy) return;
    this.#disposeHoverHelper();
    this.hoveredProxy = id;
    const proxy = id === NULL_PROXY_ID ? undefined : this.proxies[id];
    if (!proxy) return;
    // 包围盒按当前世界矩阵算，所以要先把这一支刷新到位。
    proxy.root.updateWorldMatrix(true, true);
    const helper = new THREE.BoxHelper(proxy.visualRoot, 0x8a6238);
    helper.name = 'actor-interaction-highlight';
    const material = helper.material as THREE.LineBasicMaterial;
    material.transparent = true;
    material.opacity = 0.9;
    material.depthTest = false;
    this.hoverHelper = helper;
    this.root.add(helper);
  }

  #disposeHoverHelper(): void {
    if (!this.hoverHelper) return;
    this.hoverHelper.parent?.remove(this.hoverHelper);
    this.hoverHelper.geometry.dispose();
    (this.hoverHelper.material as THREE.Material).dispose();
    this.hoverHelper = undefined;
    this.hoveredProxy = NULL_PROXY_ID;
  }

  /** 温度牌的全局开关。和 setSimpleCollisionVisible 一样是渲染世界自己的状态。 */
  public setTemperatureMarkersVisible(visible: boolean): void {
    this.temperatureMarkersVisible = visible;
    for (const proxy of this.proxies) proxy?.markers.setTemperatureVisible(visible);
  }

  public get isTemperatureMarkersVisible(): boolean {
    return this.temperatureMarkersVisible;
  }

  /**
   * 渲染世界内部的每帧动作，由渲染循环在画完之前驱动。
   *
   * 这两件都**不在边界接口上**，而且不该在：线宽是像素单位，要 resize 之后的
   * 真实画布尺寸；世界 UI 的朝向要相机。两个参数都是渲染循环自己手里的东西，
   * 跨边界发过来毫无意义。曾经借 `ClientActorSystem.beforeRender` 路过一趟，
   * 那让一个玩法类拿到了 `WebGLRenderer` 与 `Camera`。
   */
  public beforeRender(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    this.setGuidePathResolution(renderer.domElement.width, renderer.domElement.height);
    this.faceCameras(camera);
    // 下一帧挑点光源要用。相机没有父节点（渲染循环直接摆它的 position），
    // 所以本地坐标就是世界坐标，不必展开一次世界矩阵。
    this.viewPosition.copy(camera.position);
  }

  /** 让所有世界 UI 正对相机。 */
  public faceCameras(camera: THREE.Camera): void {
    for (const proxy of this.proxies) proxy?.markers.faceCamera(camera);
    this.healthPopups?.faceCamera(camera);
  }

  /** 简易碰撞盒的可视化开关。是渲染世界自己的状态，遍历不经过任何 Actor。 */
  public setSimpleCollisionVisible(visible: boolean): void {
    this.simpleCollisionVisible = visible;
    for (const proxy of this.proxies) proxy?.setSimpleCollisionVisible(visible);
  }

  public dispose(): void {
    this.#disposeHoverHelper();
    this.healthPopups?.dispose();
    this.healthPopups = undefined;
    this.ballisticPreview?.dispose();
    this.ballisticPreview = undefined;
    this.arrowShots?.dispose();
    this.arrowShots = undefined;
    this.pointLights.dispose();
    this.buildPreview.dispose();
    this.highCountBatches.dispose();
    this.fruitBatches.dispose();
    this.propInstances = undefined;
    this.fruitInstances = undefined;
    this.abilityLab?.dispose();
    this.abilityLab = undefined;
    this.abilityLabState = undefined;
    for (const guide of this.guidePaths.values()) guide.dispose();
    this.guidePaths.clear();
    this.guidePathStyles.clear();
    for (const [id, drag] of this.slimeDrags) {
      drag.dispose();
      this.#reportSlimeSurfaceDrag(id, false);
    }
    this.slimeDrags.clear();
    this.reportedSlimeDrag.clear();
    this.slimeVisuals.clear();
    this.slimeAnimators.clear();
    this.waterMotions.clear();
    this.elasticTethers.clear();
    this.dropRolls.clear();
    this.containerLids.clear();
    this.woodBows.clear();
    for (const proxy of this.proxies) proxy?.dispose();
    this.proxies.length = 0;
  }
}
