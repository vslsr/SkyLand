import * as THREE from 'three';
import {
  ACTOR_CONTROL_COMPONENT,
  ACTOR_RESIDENCY_COMPONENT,
  ActorResidencyComponent,
  ActorControlComponent,
  Actor,
  ActorWorld,
  BUOYANCY_COMPONENT,
  BuoyancyComponent,
  CARGO_COMPONENT,
  CargoComponent,
  COMBUSTIBLE_COMPONENT,
  CombustibleComponent,
  DropMotionComponent,
  ELASTIC_DETACH_COMPONENT,
  ElasticDetachComponent,
  ELASTIC_TETHER_COMPONENT,
  ElasticTetherComponent,
  HazardComponent,
  HEAT_EMITTER_COMPONENT,
  HeatEmitterComponent,
  GENERATED_PROP_COMPONENT,
  GeneratedPropComponent,
  GUIDE_PATH_COMPONENT,
  GuidePathComponent,
  INTERACTABLE_COMPONENT,
  InteractableComponent,
  ITEM_STACK_COMPONENT,
  ItemStackComponent,
  LifetimeComponent,
  PlayerMovementComponent,
  PlayerJumpComponent,
  ReplicationPolicyComponent,
  SIMPLE_COLLISION_COMPONENT,
  SimpleCollisionComponent,
  TEMPERATURE_COMPONENT,
  TemperatureComponent,
  TRANSFORM_COMPONENT,
  TransformComponent,
  VESSEL_MOTOR_COMPONENT,
  VesselMotorComponent,
} from '../../shared/actor/index.mjs';
import { createSimpleCollisionFromRender } from '../../shared/actor/simpleCollision.mjs';
import {
  COLLISION_LAYER,
  COLLISION_LAYER_SOLID,
  CollisionWorld,
  sweepSphereAgainstSimpleCollision,
} from '../../shared/collision/index.mjs';
import type { PhysicsWorld } from '../../shared/physics/PhysicsWorld.mjs';
import { simpleCollisionInstanceToPhysicsDefinitions } from '../../shared/physics/simpleCollisionToPhysics.mjs';
import { PROP_FIELD, PROP_STRIDE } from '../../shared/world/chunkContent.mjs';
import {
  PROP_KIND_BY_NAME,
  formatGeneratedPropId,
  parseGeneratedPropId,
} from '../../shared/world/generatedProp.mjs';
import { toWorldSeed } from '../../shared/world/worldConfig.mjs';
import { selectWorldPropVariant } from '../../shared/world/worldPropVariants.mjs';
import type { FillMaterialEnvironment } from '../materials/createFillMaterial';
import { NULL_PROXY_ID } from '../render/RenderScene';
import { resolveSlimeLegGroundProbeLayout } from '../render/RenderSlimeLegs';
import { frameTimeline } from '../platform/index';
import { RenderTransformBuffer } from '../render/RenderTransformBuffer';
import type { ThreeMeshProxy } from '../render/three/ThreeMeshProxy';
import { ThreeRenderScene } from '../render/three/ThreeRenderScene';
import type { SnapshotActor, SnapshotPlayer } from '../network/protocol';
import type { SceneDefinition } from '../scenes/data/SceneDefinition';
import type {
  ActorInteractionCandidate,
  SceneVisualSystem,
  VesselHudState,
} from '../scene/SceneVisualSystem';
import { ActorSnapshotBuffer } from './ActorSnapshotBuffer';
import {
  LegGroundProbeComponent,
  type GroundHeightSampler,
} from './components/LegGroundProbeComponent';
import {
  REPLICATION_COMPONENT,
  ReplicationComponent,
} from './components/ReplicationComponent';
import {
  RENDER_PROXY_COMPONENT,
  RenderProxyComponent,
} from './components/RenderProxyComponent';
import { ActorTransformSystem } from './systems/ActorTransformSystem';
import { ActorVisualParamSystem } from './systems/ActorVisualParamSystem';
import { RenderTransformSyncSystem } from './systems/RenderTransformSyncSystem';
import {
  FIRE_VISUAL_COMPONENT,
  FireVisualComponent,
} from './components/FireVisualComponent';
import { GeneratedPropFruitSystem } from './systems/GeneratedPropFruitSystem';
import { HighCountActorBatchSystem } from './systems/HighCountActorBatchSystem';
import {
  LOCAL_DERIVED_ACTOR_COMPONENT,
  LocalDerivedActorComponent,
} from './components/LocalDerivedActorComponent';
import { ActorGuidePathSyncSystem } from './systems/ActorGuidePathSyncSystem';
import {
  ActorInstanceSystem,
  type ActorInstanceCatalog,
} from './systems/ActorInstanceSystem';
import { RenderInstanceBuffer } from '../render/RenderInstanceBuffer';
import { PROP_FLOAT_STRIDE, PROP_INT_STRIDE } from '../render/propInstanceLayout';
import { FRUIT_FLOAT_STRIDE, FRUIT_INT_STRIDE } from '../render/fruitInstanceLayout';
import { ActorFruitInstanceSystem } from './systems/ActorFruitInstanceSystem';

/**
 * 一帧最多花在「建 Replica」上的毫秒数（实现路径文档 §2 的第 1 项）。
 *
 * 打点量到的问题：进房间那一帧 `render-spawn` 是 31–146 ms——服务端第一份快照里
 * 视野内的 Actor 会在同一帧里被一次性建出来，而每个 Replica 的 `createMeshProxy`
 * 都要程序化地生成一整棵模型。这是全程最大的一次卡顿，而且它**在渲染侧**，
 * 把模拟搬进 worker 一点都帮不上。
 *
 * 用时间预算而不是个数预算，是因为要压的就是「一帧的墙钟时间」：不同原型的建模
 * 成本差一个数量级，按个数配额压不住最贵的那几个。`CHUNK_BUILD_BUDGET_PER_FRAME`
 * 那条按个数的预算在这里不适用，理由同上。
 */
const REPLICA_SPAWN_BUDGET_MILLISECONDS = 4;

export interface ClientActorSystemOptions {
  definition: SceneDefinition;
  environment: FillMaterialEnvironment;
  /** 与 ChunkStreamer 相同的房间世界种子，用于选择同 kind 的玩法原型变体。 */
  worldSeed?: number;
  now?: () => number;
  /**
   * 场景共用的碰撞世界。传进来时 Actor 与流式 chunk 的碰撞体落在同一张
   * 空间网格上，玩家推出与相机悬臂各查一次就够；不传就自己建一个，
   * 单独使用这个 System 的测试因此不需要额外搭场景。
   */
  collision?: CollisionWorld;
  physics?: PhysicsWorld;
  /**
   * 场景共用的渲染世界与它的边界缓冲。
   *
   * 传进来时 Actor Replica 与本地玩家共用同一个渲染世界、同一段 transform SoA
   * ——本地玩家因此也能拿到 ProxyId。不传就自己建一对，单独使用这个 System 的
   * 测试不需要额外搭场景。
   */
  renderScene?: ThreeRenderScene;
  transforms?: RenderTransformBuffer;
  /**
   * 一帧的建模预算，毫秒。测试传 `Infinity` 就回到「一帧建完」的旧行为，
   * 传 0 则每帧只建一个——预算再紧也保证有进度。
   */
  spawnBudgetMilliseconds?: number;
  /** 单调时钟。和 `now` 分开：`now` 是快照用的时间轴，测试里不会在一帧内推进。 */
  spawnClock?: () => number;
  /**
   * 地形高度查询。只有长腿的 Actor 会用到——它每帧采五个点决定脚落在哪儿。
   * 不传时腿退回 Actor 自己脚下的平面，单独跑这个 System 的测试因此不需要地形。
   */
  sampleGroundHeight?: GroundHeightSampler;
}

type PropStateSnapshot = {
  /** 掉血形态才有；可再生物件没有血量。 */
  health?: number;
  maximumHealth?: number;
  removed: boolean;
  /** 可再生物件下一次可采的绝对服务端秒数。 */
  readyAt?: number;
  revision: number;
};
type PropOverrideTarget = (chunkX: number, chunkZ: number, propIndex: number, removed: boolean) => void;

type ActorPose = { x: number; y: number; z: number; yaw: number };

function composeAttachedPose(parent: ActorPose, local: NonNullable<SnapshotActor['localTransform']>): ActorPose {
  const sinYaw = Math.sin(parent.yaw);
  const cosYaw = Math.cos(parent.yaw);
  return {
    x: parent.x + cosYaw * local.x + sinYaw * local.z,
    y: parent.y + local.y,
    z: parent.z - sinYaw * local.x + cosYaw * local.z,
    yaw: parent.yaw + local.yaw,
  };
}

/** 用同时间戳的外部 Actor 姿态补出附件位置；线上无需复制附件世界 Transform。 */
function resolveExternalAttachmentTransforms(
  snapshots: readonly SnapshotActor[],
  externalActors: readonly SnapshotPlayer[],
): SnapshotActor[] {
  const actors = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const external = new Map<string, ActorPose>(externalActors.map((actor) => [actor.id, {
    x: actor.x,
    y: actor.y ?? 0,
    z: actor.z,
    yaw: actor.yaw,
  }]));
  const resolved = new Map<string, ActorPose>();
  const resolving = new Set<string>();
  const resolve = (snapshot: SnapshotActor): ActorPose | undefined => {
    if (snapshot.transform) return snapshot.transform;
    const cached = resolved.get(snapshot.id);
    if (cached) return cached;
    if (!snapshot.parentActorId || !snapshot.localTransform || resolving.has(snapshot.id)) return undefined;
    resolving.add(snapshot.id);
    const parentSnapshot = actors.get(snapshot.parentActorId);
    const parent = external.get(snapshot.parentActorId)
      ?? (parentSnapshot ? resolve(parentSnapshot) : undefined);
    resolving.delete(snapshot.id);
    if (!parent) return undefined;
    const pose = composeAttachedPose(parent, snapshot.localTransform);
    resolved.set(snapshot.id, pose);
    return pose;
  };
  return snapshots.map((snapshot) => {
    if (snapshot.transform) return snapshot;
    const transform = resolve(snapshot);
    return transform ? { ...snapshot, transform } : snapshot;
  });
}

/** 接收服务端完整 Actor 快照并维护对应的客户端 Replica。 */
export class ClientActorSystem implements SceneVisualSystem {
  /**
   * Game World 与 Render World 之间那条边界（路线图 §2 / 第 1 步）。
   * Actor 手上只有 proxyId；Object3D 全部住在 renderScene 里，
   * 两侧靠 transforms 这段字节通信。
   */
  private readonly transforms: RenderTransformBuffer;
  private readonly renderScene: ThreeRenderScene;
  /**
   * 这个 System 往场景图里挂东西的那个节点，就是渲染世界的根。
   *
   * 两者必须是同一个组：proxy 由渲染世界挂载，合批与悬停高亮由这里挂载，
   * 分成两个节点会让其中一个不在场景图里。
   */
  public get root(): THREE.Group {
    return this.renderScene.root;
  }
  private readonly world = new ActorWorld();
  private readonly archetypes: Map<string, SceneDefinition['actorArchetypes'][number]>;
  private readonly snapshots = new ActorSnapshotBuffer();
  private readonly now: () => number;
  /** 准星射线的两端，复用同一对数组，避免每帧产生临时对象。 */
  private readonly pickStart: [number, number, number] = [0, 0, 0];
  private readonly pickEnd: [number, number, number] = [0, 0, 0];
  /** 解析求交要的就是这两样，逐 Actor 改字段而不是每次新建对象。 */
  private readonly pickProbe: { collision: SimpleCollisionComponent; transform: TransformComponent } = {
    collision: undefined as unknown as SimpleCollisionComponent,
    transform: undefined as unknown as TransformComponent,
  };
  private readonly collision: CollisionWorld;
  private readonly physics?: PhysicsWorld;
  private readonly highCountBatches: HighCountActorBatchSystem;
  /** 合批内容的实例通道，以及渲染侧反查原型用的那张顺序表。 */
  private readonly instances = new RenderInstanceBuffer(PROP_INT_STRIDE, PROP_FLOAT_STRIDE);
  /** 树上果子走另一条通道：它的记录里没有原型、没有驻留态，形状不一样。 */
  private readonly fruitInstances = new RenderInstanceBuffer(FRUIT_INT_STRIDE, FRUIT_FLOAT_STRIDE);
  private readonly archetypeOrder: string[];
  private readonly fruit: GeneratedPropFruitSystem;
  /** actorId → 登记进碰撞世界的实例，逐帧复用，避免每帧产生一批临时对象。 */
  private readonly colliderInstances = new Map<string, {
    collision: SimpleCollisionComponent;
    transform: TransformComponent;
    layers: number;
    actorId: string;
  }>();
  /** Replica 的父节点若是 players 快照里的外部 Actor，就在这里保存 Attach 关系。 */
  private readonly externalParentActorIds = new Map<string, string>();
  /** 快照换过一批 Actor 之后必须重新登记，置位后由下一次查询或 update 兑现。 */
  private collidersStale = true;
  private hoveredActorId?: string;
  private hoverHelper?: THREE.BoxHelper;
  private readonly generatedPropChunks = new Map<string, Set<string>>();
  private readonly generatedPropStates = new Map<string, PropStateSnapshot>();
  private generatedPropOverrideTarget?: PropOverrideTarget;
  /**
   * 物件种类 → 带权原型变体。和服务端一样从场景的 gameplay.worldProps 建表，
   * 再用房间种子与放置地址选择，两端因此不需要在快照里带 archetypeId。
   */
  private readonly generatedPropArchetypeVariants = new Map<
    number,
    Array<{
      archetype: SceneDefinition['actorArchetypes'][number];
      weight: number;
    }>
  >();
  private readonly worldSeed: number;
  private readonly spawnBudgetMilliseconds: number;
  private readonly spawnClock: () => number;
  /** 地形高度查询；只有长腿 Actor 的落脚采样会用到。 */
  private readonly sampleGroundHeight?: GroundHeightSampler;

  public constructor(options: ClientActorSystemOptions) {
    this.archetypes = new Map(
      options.definition.actorArchetypes.map((definition) => [definition.id, definition]),
    );
    for (const [name, variants] of Object.entries(options.definition.gameplay.worldProps ?? {})) {
      const kind = PROP_KIND_BY_NAME[name];
      if (kind === undefined || !Array.isArray(variants)) continue;
      const resolved = variants.flatMap((variant) => {
        const archetype = this.archetypes.get(variant.archetypeId);
        return archetype?.components.generatedProp
          ? [{ archetype, weight: variant.weight }]
          : [];
      });
      if (resolved.length > 0) this.generatedPropArchetypeVariants.set(kind, resolved);
    }
    this.worldSeed = toWorldSeed(options.worldSeed);
    this.now = options.now ?? (() => Date.now());
    this.collision = options.collision ?? new CollisionWorld();
    this.physics = options.physics;
    this.highCountBatches = new HighCountActorBatchSystem(options.environment, this.archetypes);
    // 两侧共用的原型顺序：玩法侧写下标，渲染侧按同一份表反查 render 定义。
    this.archetypeOrder = [...this.archetypes.keys()];
    this.fruit = new GeneratedPropFruitSystem(options.environment);
    this.spawnBudgetMilliseconds = options.spawnBudgetMilliseconds ?? REPLICA_SPAWN_BUDGET_MILLISECONDS;
    this.spawnClock = options.spawnClock
      ?? (() => (globalThis.performance ?? Date).now());
    this.sampleGroundHeight = options.sampleGroundHeight;
    this.transforms = options.transforms ?? new RenderTransformBuffer();
    this.renderScene = options.renderScene
      ?? new ThreeRenderScene(
        createActorWorldRoot(),
        options.environment,
        options.definition.renderer.ocean,
      );
    // 客户端不运行 AttachmentSystem：最终世界坐标来自快照插值，不能被
    // localTransform 再次解算覆盖。
    //
    // 前两个 System 就是那条边界：ActorTransformSystem 只写 SoA 字节，
    // RenderTransformSyncSystem 翻面并交给渲染世界。后面所有表现 System 读的都是
    // 已经摆好位置的 matrixWorld，所以这两个必须排在最前且相邻。
    this.world.addSystem(new ActorTransformSystem(this.transforms));
    // 参数要和 transform 同一次翻面，所以必须夹在写入与 publish 之间。
    this.world.addSystem(new ActorVisualParamSystem(this.transforms));
    // 合批内容走自己那条通道，但同样是「写字节」，所以和 SoA 写入排在一起、
    // 都在 publish 之前。这条现在还没有双缓冲（同一帧写完就读），排在这里是为了
    // 等它也跨线程时不用再挪一次。
    this.world.addSystem(new ActorInstanceSystem(this.instances, this.createInstanceCatalog()));
    this.world.addSystem(new ActorFruitInstanceSystem(
      this.fruitInstances,
      // 果子的熟没熟由绝对服务端时间决定，所以喂的是换算过的服务端时钟，
      // 不是 ActorWorld 的本地 elapsedSeconds。
      { bearsFruit: (id) => Boolean(this.archetypes.get(id)?.components.generatedProp?.regrow) },
      () => {
        const serverTime = this.snapshots.serverTimeAt(this.now());
        return serverTime === undefined ? undefined : serverTime / 1000;
      },
    ));
    this.world.addSystem(new RenderTransformSyncSystem(this.transforms, this.renderScene));
    this.world.addSystem(new ActorGuidePathSyncSystem(this.renderScene));
    // 到这里 Actor 世界里就只剩六个 System 了，而且**一个都不 import three**：
    // 四个写字节、一个发命令、一个翻面。船体波动、货箱浮沉、附着继承、弹性拉伸
    // 与脱落翻滚全部搬进了渲染世界（实现路径文档 §1.75）。
  }

  public syncSnapshots(
    snapshots: readonly SnapshotActor[],
    serverTime: number,
    receivedAt = this.now(),
    externalActors: readonly SnapshotPlayer[] = [],
  ): void {
    this.snapshots.push(
      resolveExternalAttachmentTransforms(snapshots, externalActors),
      serverTime,
      receivedAt,
    );
  }

  private applySnapshotSet(snapshots: readonly SnapshotActor[]): void {
    this.collidersStale = true;
    const liveIds = new Set<string>();
    const applicableSnapshots: SnapshotActor[] = [];

    // 生成物件的偏离态可能先于对应 Chunk 到达。先缓存掩码；Chunk 挂载时再构造 Actor，
    // 避免在尚不可见的区域创建一个可以被交互命中的逻辑目标。
    for (const snapshot of snapshots) {
      liveIds.add(snapshot.id);
      if (snapshot.propState) {
        this.rememberGeneratedPropState(snapshot.id, snapshot.propState, snapshot.revision);
        if (!this.world.getActor(snapshot.id)) continue;
      }
      applicableSnapshots.push(snapshot);
    }

    // Pass 1a：原型换了的先删掉，让它走下面的新建路径。
    for (const snapshot of applicableSnapshots) {
      const actor = this.world.getActor(snapshot.id) as Actor | undefined;
      if (actor && actor.archetypeId !== this.resolveSnapshotArchetypeId(snapshot)) {
        this.world.removeActor(actor.id);
      }
    }

    // Pass 1b：按预算创建。没轮到的这一帧就不存在，而下一帧的快照集合里它还在——
    // 所以不需要维护待建队列，也就不会有「排着队的 Actor 已经离开视野」这种脏状态。
    const pending = new Map<string, SnapshotActor>();
    for (const snapshot of applicableSnapshots) {
      if (!this.world.getActor(snapshot.id)) pending.set(snapshot.id, snapshot);
    }
    const spawnDeadline = this.spawnClock() + this.spawnBudgetMilliseconds;
    let spawned = 0;
    /**
     * 建一个 Replica，父节点优先。
     *
     * 「父节点可以出现在快照的任意位置」是这一遍原本就保证的性质，分帧之后更要保住：
     * 孩子先于父节点被建出来的话，Pass 2 会把它当成「挂在外部 Actor 上」——那条路径
     * 是给玩家用的，一个本该跟着船走的货箱会被当成玩家嘴里叼着的东西。
     */
    const spawn = (snapshot: SnapshotActor, chain: Set<string>): Actor | undefined => {
      const existing = this.world.getActor(snapshot.id) as Actor | undefined;
      if (existing) return existing;
      // 脏数据里的环形父子关系不该把客户端拖进死循环。
      if (chain.has(snapshot.id)) return undefined;
      chain.add(snapshot.id);
      const parentActorId = snapshot.parentActorId ?? undefined;
      // 只有「父节点也在这一批待建里」才需要递归；已经在世界里、或根本不是 Replica
      // （玩家）的父节点都走不到这里。
      const parentSnapshot = parentActorId === undefined
        ? undefined
        : pending.get(parentActorId);
      // 父节点建不出来（预算用完或脏数据）就连孩子一起推到下一帧。
      if (parentSnapshot && !spawn(parentSnapshot, chain)) return undefined;
      // 预算再紧也要建一个：否则视野里新出现的 Actor 可能永远排不上。
      if (spawned > 0 && this.spawnClock() >= spawnDeadline) return undefined;
      const actor = this.createReplica(snapshot);
      spawned += 1;
      return actor;
    };
    for (const snapshot of applicableSnapshots) spawn(snapshot, new Set());

    // Pass 1c：这一帧已经存在的都要带上复制标记。
    for (const snapshot of applicableSnapshots) {
      const actor = this.world.getActor(snapshot.id) as Actor | undefined;
      if (actor && !actor.hasComponents(REPLICATION_COMPONENT)) {
        actor.addComponent(new ReplicationComponent());
      }
    }

    // Pass 2：父子关系是离散状态，直接采用当前采样快照的目标值。
    for (const snapshot of applicableSnapshots) {
      const actor = this.world.getActor(snapshot.id) as Actor | undefined;
      if (!actor) continue;
      const parentActorId = snapshot.parentActorId ?? undefined;
      // 玩家等外部 Actor 不在 Replica ActorWorld 中；它们的姿态已在快照入缓冲前合成。
      if (parentActorId && !this.world.getActor(parentActorId)) {
        this.externalParentActorIds.set(actor.id, parentActorId);
      } else {
        this.externalParentActorIds.delete(actor.id);
      }
      if ((!parentActorId || this.world.getActor(parentActorId)) && actor.parent?.id !== parentActorId) {
        this.world.setActorParent(actor.id, parentActorId, { worldPositionStays: true });
      }
    }

    // Pass 3：Component 脚本读取到的 Transform 同时包含局部坐标和世界坐标。
    for (const snapshot of applicableSnapshots) {
      const actor = this.world.getActor(snapshot.id) as Actor | undefined;
      if (actor) this.applySnapshot(actor, snapshot);
    }

    for (const actor of this.world.actors() as Actor[]) {
      if (
        actor.hasComponents(REPLICATION_COMPONENT)
        && !actor.hasComponents(LOCAL_DERIVED_ACTOR_COMPONENT)
        && !liveIds.has(actor.id)
      ) {
        this.externalParentActorIds.delete(actor.id);
        this.world.removeActor(actor.id);
      }
    }
    if (this.hoveredActorId && !this.world.getActor(this.hoveredActorId)) {
      this.setHoveredActorId(undefined);
    }
  }

  public update(deltaSeconds: number, elapsedSeconds: number): void {
    // 打点按「第 2 步之后这段代码会在哪个线程上」分：
    // `sim-actors` 进 Sim Worker，`render-batches` / `render-visuals` 留在主线程。
    // `sim-actors` 只包玩法：快照应用与 Actor 世界的 System。
    // Replica 的装配单独打点——`createMeshProxy` 会在渲染世界里建一整棵模型，
    // 那是渲染成本，混进 sim 会把「搬进 worker 能省多少」算高。
    frameTimeline.measure('sim-actors', () => {
      this.applySnapshotSet(this.snapshots.sample(this.now()));
      this.world.update(deltaSeconds, elapsedSeconds);
    });
    frameTimeline.measure('render-batches', () => {
      this.highCountBatches.sync(this.instances, this.archetypeOrder);
      this.fruit.sync(this.fruitInstances);
      // 和高数量批次一样按需挂进场景：没有果树的地图不会多出一层空节点。
      if (this.fruit.instanceCount > 0 && !this.fruit.root.parent) this.root.add(this.fruit.root);
      if (this.highCountBatches.root.children.length > 0 && !this.highCountBatches.root.parent) {
        this.root.add(this.highCountBatches.root);
      }
    });
    // 渲染世界自己的表现系统。它们读的是刚翻面的参数段，所以排在 world.update 之后。
    // deltaSeconds 目前仍来自模拟侧——第 3 步渲染进 worker 后换成渲染线程的时钟。
    frameTimeline.measure(
      'render-visuals',
      () => this.renderScene.updateVisuals(this.transforms, deltaSeconds, elapsedSeconds),
    );
    frameTimeline.measure('sim-colliders', () => {
      this.publishColliders();
      this.hoverHelper?.update();
    });
  }

  /**
   * 把 Actor 的碰撞盒刷新进空间网格。
   *
   * 成本随场景 Actor 数（上限 256）走，不随世界大小走。Actor 通常只挪动
   * 一点点，网格因此多半只是原地改数值，不做任何 Map 操作。
   *
   * 一帧内会被本地预测和回滚重放调用多次，所以只在 Actor 集合真的变过时重登记。
   */
  public refreshColliders(): void {
    if (!this.collidersStale) return;
    this.publishColliders();
  }

  private publishColliders(): void {
    this.collidersStale = false;
    const live = new Set<string>();
    for (const actor of this.world.query(
      TRANSFORM_COMPONENT,
      SIMPLE_COLLISION_COMPONENT,
    ) as Actor[]) {
      // 与服务端一致：叼在嘴上的东西不参与碰撞，否则本地预测会被自己嘴里
      // 那一个顶住，走不动。
      if (this.externalParentActorIds.has(actor.id)) continue;
      live.add(actor.id);
      let instance = this.colliderInstances.get(actor.id);
      if (!instance) {
        instance = {
          collision: actor.requireComponent(SIMPLE_COLLISION_COMPONENT) as SimpleCollisionComponent,
          transform: actor.requireComponent(TRANSFORM_COMPONENT) as TransformComponent,
          layers: COLLISION_LAYER_SOLID,
          actorId: actor.id,
        };
        this.colliderInstances.set(actor.id, instance);
      }
      this.collision.setDynamic(actor.id, instance);
      const definitions = simpleCollisionInstanceToPhysicsDefinitions(instance);
      if (definitions.length > 0) this.physics?.setActorCollider(actor.id, definitions);
    }
    for (const actorId of Array.from(this.colliderInstances.keys())) {
      if (live.has(actorId)) continue;
      this.colliderInstances.delete(actorId);
      this.collision.removeDynamic(actorId);
      this.physics?.removeActorCollider(actorId);
    }
  }

  public beforeRender(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    // 线宽是像素单位，要 resize 之后的真实画布尺寸；世界 UI 的朝向也只有到这里
    // 才拿得到相机。两件都是渲染世界自己的事，这里只负责把参数递过去。
    this.renderScene.setGuidePathResolution(
      renderer.domElement.width,
      renderer.domElement.height,
    );
    this.renderScene.faceCameras(camera);
  }

  public dispose(): void {
    this.disposeHoverHelper();
    this.snapshots.clear();
    for (const actorId of this.colliderInstances.keys()) {
      this.collision.removeDynamic(actorId);
      this.physics?.removeActorCollider(actorId);
    }
    this.colliderInstances.clear();
    this.externalParentActorIds.clear();
    this.highCountBatches.dispose();
    this.fruit.dispose();
    this.world.dispose();
    // world.dispose() 逐个跑 endPlay，正常路径下每个 RenderProxyComponent 都会
    // 还掉自己的槽位。这一句兜住不正常的路径：渲染世界的资源不该依赖「每个 proxy
    // 都恰好有一个活着的 Actor 持有它」这条不变量才能释放。
    //
    // 渲染世界**归场景所有**（玩家的 proxy 也在里面），但这一帧的驱动和释放都
    // 托管给 Actor 世界：翻面（`RenderTransformSyncSystem`）必须夹在写 SoA 与
    // 依赖翻面结果的 Actor 表现 System 之间，拆不出来。第 2 步要拆的正是这个
    // 夹心结构；在那之前，「谁驱动谁就负责释放」比多一个只管析构的系统更清楚。
    this.renderScene.dispose();
  }

  public getActor(actorId: string): Actor | undefined {
    return this.world.getActor(actorId) as Actor | undefined;
  }

  /** 渲染世界本身。表现搬过去之后，测试与调试代码经由它查渲染侧状态。 */
  public getRenderScene(): ThreeRenderScene {
    return this.renderScene;
  }

  public getActorRenderProxy(actorId: string): ThreeMeshProxy | undefined {
    const actor = this.world.getActor(actorId) as Actor | undefined;
    return actor ? this.resolveRender(actor) : undefined;
  }

  public findOwnedActorId(playerId: string): string | undefined {
    return (this.world.query(ACTOR_CONTROL_COMPONENT) as Actor[]).find((actor) => (
      (actor.requireComponent(ACTOR_CONTROL_COMPONENT) as ActorControlComponent).ownerPlayerId === playerId
    ))?.id;
  }

  public findControllableActorId(): string | undefined {
    return (this.world.query(ACTOR_CONTROL_COMPONENT, VESSEL_MOTOR_COMPONENT) as Actor[]).find((actor) => (
      !(actor.requireComponent(ACTOR_CONTROL_COMPONENT) as ActorControlComponent).ownerPlayerId
    ))?.id;
  }

  public resolveSimpleCollision(
    position: { x: number; z: number },
    radius: number,
    maximumStepHeight = 0,
    moverHeight = radius * 2,
  ): { x: number; z: number } {
    // 候选来自空间网格，窄相仍是原来的两轮推出，手感不变。
    this.refreshColliders();
    return this.collision.resolveCircle(position, radius, {
      verticalProfile: {
        minimumY: 0,
        maximumY: Math.max(0, moverHeight),
        maximumStepHeight,
      },
    });
  }

  public setSimpleCollisionVisible(visible: boolean): void {
    // 碰撞盒可视化是渲染世界自己的状态：这里不再遍历 Actor。
    this.renderScene.setSimpleCollisionVisible(visible);
  }

  public setGeneratedPropOverrideTarget(target?: PropOverrideTarget): void {
    this.generatedPropOverrideTarget = target;
    if (!target) return;
    for (const [actorId, state] of this.generatedPropStates) {
      const identity = parseGeneratedPropId(actorId);
      if (identity) target(identity.chunkX, identity.chunkZ, identity.propIndex, state.removed);
    }
  }

  /** Chunk 装载时只构造逻辑 Actor；物件的网格与碰撞仍由 Chunk 合批持有。 */
  public mountGeneratedPropChunk(
    key: string,
    chunkX: number,
    chunkZ: number,
    props: Int32Array,
    propCount: number,
  ): void {
    if (this.generatedPropArchetypeVariants.size === 0) return;
    this.unmountGeneratedPropChunk(key);
    const actorIds = new Set<string>();
    for (let propIndex = 0; propIndex < propCount; propIndex += 1) {
      const offset = propIndex * PROP_STRIDE;
      const kind = props[offset + PROP_FIELD.KIND];
      const archetype = this.archetypeForGeneratedProp(kind, chunkX, chunkZ, propIndex);
      // 没有原型的种类是纯布景（草），只有网格没有逻辑 Actor。
      if (!archetype?.components.generatedProp) continue;
      const actorId = formatGeneratedPropId(kind, chunkX, chunkZ, propIndex);
      actorIds.add(actorId);
      if (this.world.getActor(actorId)) continue;
      const scale = props[offset + PROP_FIELD.SCALE_THOUSANDTHS] / 1000;
      const actor = new Actor(actorId, archetype.id);
      actor.addComponent(new TransformComponent({
        position: [
          props[offset + PROP_FIELD.X_MM] / 1000,
          props[offset + PROP_FIELD.Y_MM] / 1000,
          props[offset + PROP_FIELD.Z_MM] / 1000,
        ],
        yaw: props[offset + PROP_FIELD.ROTATION_MRAD] / 1000,
      }));
      actor.addComponent(new GeneratedPropComponent(archetype.components.generatedProp, {
        kind,
        chunkX,
        chunkZ,
        propIndex,
        scale,
      }));
      if (archetype.components.interactable) {
        actor.addComponent(new InteractableComponent(archetype.components.interactable));
      }
      if (archetype.components.replicationPolicy) {
        actor.addComponent(new ReplicationPolicyComponent(archetype.components.replicationPolicy));
      }
      actor.addComponent(new LocalDerivedActorComponent());
      this.world.addActor(actor);
      const cachedState = this.generatedPropStates.get(actorId);
      if (cachedState) this.applyGeneratedPropState(actor, cachedState);
    }
    this.generatedPropChunks.set(key, actorIds);
  }

  public unmountGeneratedPropChunk(key: string): void {
    const actorIds = this.generatedPropChunks.get(key);
    if (!actorIds) return;
    this.generatedPropChunks.delete(key);
    for (const actorId of actorIds) this.world.removeActor(actorId);
  }

  public setTemperatureVisible(visible: boolean): void {
    // 和 setSimpleCollisionVisible 一样：这是渲染世界自己的状态，不再在 Actor 上镜像。
    this.renderScene.setTemperatureMarkersVisible(visible);
  }

  /**
   * 准星指向的可交互 Actor。
   *
   * **解析求交，不打场景图**（实现路径文档 §3 的待决事项，已拍板）。
   *
   * 这里以前拿 `THREE.Raycaster` 打 proxy 的场景图。第 3 步把渲染世界搬进线程之后
   * 那件事就地做不了，而它的调用方（交互控制器）是同步的玩法逻辑。两条路可选：
   * 让渲染线程每帧回送「准星命中了谁」，或者在玩法侧用碰撞体重做一次求交。
   *
   * 选后者，三条理由：
   *
   * 1. **回送会晚一帧。** 准星拾取直接喂 HUD 提示与按键判定，玩家看得见这一帧的
   *    延迟；而且那样一来玩法的响应节奏就被渲染帧率绑住了。
   * 2. **这一半本来就已经这么做了。** 合批掉落物没有独立 Object3D，它们的拾取
   *    一直是拿权威 Transform 加碰撞半径解析算的。合并之后只剩一条路径。
   * 3. **每个可交互 Actor 都带 `SimpleCollisionComponent`。** 它由渲染世界在建
   *    proxy 时按模型尺寸派生（`info.simpleCollision`），所以这个盒子本来就是那个
   *    模型的紧包围盒——不是另编的一套近似。
   *
   * 代价是精度：射线打的是三角形，这里打的是有向盒／圆柱。对准星拾取来说这个
   * 方向是对的——玩家瞄的是轮廓，不是树冠枝叶之间的缝。
   */
  public pickInteractableActor(
    origin: readonly [number, number, number],
    direction: readonly [number, number, number],
    maximumDistance = 30,
  ): ActorInteractionCandidate | undefined {
    const length = Math.hypot(direction[0], direction[1], direction[2]);
    if (length < 1e-6) return undefined;
    const scale = maximumDistance / length;
    this.pickStart[0] = origin[0];
    this.pickStart[1] = origin[1];
    this.pickStart[2] = origin[2];
    this.pickEnd[0] = origin[0] + direction[0] * scale;
    this.pickEnd[1] = origin[1] + direction[1] * scale;
    this.pickEnd[2] = origin[2] + direction[2] * scale;

    let nearest: { fraction: number; candidate: ActorInteractionCandidate } | undefined;
    for (const actor of this.world.query(
      INTERACTABLE_COMPONENT,
      TRANSFORM_COMPONENT,
      SIMPLE_COLLISION_COMPONENT,
    ) as Actor[]) {
      const interactable = actor.requireComponent(INTERACTABLE_COMPONENT) as InteractableComponent;
      if (!interactable.enabled) continue;
      this.pickProbe.collision = actor.requireComponent(
        SIMPLE_COLLISION_COMPONENT,
      ) as SimpleCollisionComponent;
      this.pickProbe.transform = actor.requireComponent(TRANSFORM_COMPONENT) as TransformComponent;
      // 半径 0 就是一条线段——扫掠球退化成射线，盒与圆柱两种形状、朝向、
      // 中心偏移和高度区间全都由这一个函数负责，和相机悬臂用的是同一份实现。
      const fraction = sweepSphereAgainstSimpleCollision(
        this.pickStart,
        this.pickEnd,
        0,
        this.pickProbe,
      );
      // 返回 1 表示整段都没碰到。
      if (fraction >= 1) continue;
      if (nearest && fraction >= nearest.fraction) continue;
      nearest = { fraction, candidate: this.createInteractionCandidate(actor, interactable) };
    }
    return nearest?.candidate;
  }

  public findNearbyInteractableActor(
    position: { x: number; z: number },
  ): ActorInteractionCandidate | undefined {
    this.refreshColliders();
    let nearest: { distance: number; candidate: ActorInteractionCandidate } | undefined;
    const visited = new Set<string>();
    // 生成物件的静态碰撞和普通 Actor 的动态碰撞都带 actorId，因此交互查询与世界大小、
    // Actor 总数无关，只访问玩家附近几个空间格。
    this.collision.forEachNear(position.x, position.z, 12, COLLISION_LAYER.MOVEMENT, (instance) => {
      const actorId = (instance as { actorId?: string }).actorId;
      if (!actorId || visited.has(actorId)) return;
      visited.add(actorId);
      const actor = this.world.getActor(actorId) as Actor | undefined;
      if (!actor) return;
      const interactable = actor.getComponent(INTERACTABLE_COMPONENT) as InteractableComponent | undefined;
      const transform = actor.getComponent(TRANSFORM_COMPONENT) as TransformComponent | undefined;
      if (!interactable?.enabled || !transform) return;
      const distance = Math.hypot(transform.x - position.x, transform.z - position.z);
      if (distance > interactable.maximumDistance || (nearest && distance >= nearest.distance)) {
        return;
      }
      nearest = {
        distance,
        candidate: this.createInteractionCandidate(actor, interactable),
      };
    });
    return nearest?.candidate;
  }

  /**
   * 这名玩家手上那一株。
   *
   * 拉着的时候它可能已经被拖到就近搜索半径之外，叼着的时候它的 interactable
   * 又是关掉的——两种情况都不会出现在就近候选里，但交互键必须能指向它，
   * 否则玩家没有任何办法取消或放下。遍历量由 AOI 内的可拔物件数决定。
   */
  public findHeldInteractableActor(playerId: string): ActorInteractionCandidate | undefined {
    for (const actor of this.world.query(
      ELASTIC_TETHER_COMPONENT,
      INTERACTABLE_COMPONENT,
    ) as Actor[]) {
      const tether = actor.requireComponent(ELASTIC_TETHER_COMPONENT) as ElasticTetherComponent;
      if (tether.holderPlayerId !== playerId && this.externalParentActorIds.get(actor.id) !== playerId) {
        continue;
      }
      return this.createInteractionCandidate(
        actor,
        actor.requireComponent(INTERACTABLE_COMPONENT) as InteractableComponent,
      );
    }
    return undefined;
  }

  public setInteractionMarkerActorId(actorId?: string, inputLabel?: string): void {
    // 生成物件带 InteractableComponent 却没有 proxy，所以「目标没有 proxyId」
    // 与「没有选中」都是合法输入，统一退化成 NULL_PROXY_ID。
    const actor = actorId ? this.world.getActor(actorId) as Actor | undefined : undefined;
    const proxy = actor?.getComponent(RENDER_PROXY_COMPONENT) as RenderProxyComponent | undefined;
    this.renderScene.setInteractionMarker(proxy?.proxyId ?? NULL_PROXY_ID, inputLabel ?? '');
  }

  public setHoveredActorId(actorId?: string): void {
    if (actorId === this.hoveredActorId) return;
    this.disposeHoverHelper();
    this.hoveredActorId = actorId;
    const actor = actorId ? this.world.getActor(actorId) as Actor | undefined : undefined;
    const render = actor ? this.resolveRender(actor) : undefined;
    if (!render) return;
    render.root.updateWorldMatrix(true, true);
    this.hoverHelper = new THREE.BoxHelper(render.visualRoot, 0x8a6238);
    this.hoverHelper.name = 'actor-interaction-highlight';
    const material = this.hoverHelper.material as THREE.LineBasicMaterial;
    material.transparent = true;
    material.opacity = 0.9;
    material.depthTest = false;
    this.root.add(this.hoverHelper);
  }

  public getVesselHudState(playerId: string): VesselHudState | undefined {
    const actorId = this.findOwnedActorId(playerId);
    const actor = actorId ? this.world.getActor(actorId) as Actor | undefined : undefined;
    if (!actor) return undefined;
    const motor = actor.getComponent(VESSEL_MOTOR_COMPONENT) as VesselMotorComponent | undefined;
    const buoyancy = actor.getComponent(BUOYANCY_COMPONENT) as BuoyancyComponent | undefined;
    if (!motor || !buoyancy) return undefined;
    return {
      actorId: actor.id,
      speed: motor.speed,
      cargoMass: buoyancy.cargoMass,
      damagedPartCount: buoyancy.damagedPartCount,
      floatState: buoyancy.state as VesselHudState['floatState'],
      eventRevision: buoyancy.eventRevision,
      lastEvent: buoyancy.lastEvent ?? null,
    };
  }

  /**
   * 「哪些原型走合批、什么时候换单个模板」是玩法事实，所以由这一侧给出。
   * 判据就是原型有没有 `itemStack`——`createReplica` 正是照它提前返回、不建 proxy 的。
   */
  private createInstanceCatalog(): ActorInstanceCatalog {
    const archetypeIndex = new Map<string, number>();
    this.archetypeOrder.forEach((id, index) => archetypeIndex.set(id, index));
    const singleModels = new Set(['line-art-fruit-pile', 'line-art-wood-log']);
    return {
      archetypeIndex,
      isBatched: (archetypeId) => (
        this.archetypes.get(archetypeId)?.components.itemStack !== undefined
      ),
      supportsSingle: (archetypeId) => {
        const model = this.archetypes.get(archetypeId)?.components.render?.model;
        return model !== undefined && singleModels.has(model);
      },
    };
  }

  private createReplica(snapshot: SnapshotActor): Actor {
    const archetypeId = this.resolveSnapshotArchetypeId(snapshot);
    const archetype = this.archetypes.get(archetypeId);
    if (!archetype) throw new Error(`客户端缺少 Actor 原型：${archetypeId}`);
    if (!snapshot.transform) throw new Error(`Actor ${snapshot.id} 的网络副本缺少 Transform`);
    const actor = new Actor(snapshot.id, archetypeId);
    actor.addComponent(new TransformComponent({
      position: [snapshot.transform.x, snapshot.transform.y, snapshot.transform.z],
      yaw: snapshot.transform.yaw,
    }));
    if (archetype.components.guidePath) {
      actor.addComponent(new GuidePathComponent(archetype.components.guidePath));
    }
    if (archetype.components.buoyancy) {
      actor.addComponent(new BuoyancyComponent(archetype.components.buoyancy));
    }
    if (archetype.components.playerMovement) {
      actor.addComponent(new PlayerMovementComponent(archetype.components.playerMovement));
    }
    if (archetype.components.playerJump) {
      actor.addComponent(new PlayerJumpComponent(archetype.components.playerJump));
    }
    if (archetype.components.vesselMotor) {
      actor.addComponent(new VesselMotorComponent(archetype.components.vesselMotor));
      actor.addComponent(new ActorControlComponent());
    }
    if (archetype.components.interactable) {
      actor.addComponent(new InteractableComponent(archetype.components.interactable));
    }
    if (archetype.components.cargo) {
      actor.addComponent(new CargoComponent(archetype.components.cargo));
    }
    if (archetype.components.elasticTether) {
      actor.addComponent(new ElasticTetherComponent(archetype.components.elasticTether));
    }
    if (archetype.components.elasticDetach) {
      actor.addComponent(new ElasticDetachComponent(archetype.components.elasticDetach));
    }
    if (archetype.components.hazard) {
      actor.addComponent(new HazardComponent(archetype.components.hazard));
    }
    if (archetype.components.temperature) {
      actor.addComponent(new TemperatureComponent(archetype.components.temperature));
    }
    if (archetype.components.combustible) {
      actor.addComponent(new CombustibleComponent(archetype.components.combustible));
    }
    if (archetype.components.heatEmitter) {
      actor.addComponent(new HeatEmitterComponent(archetype.components.heatEmitter));
    }
    if (archetype.components.itemStack) {
      actor.addComponent(new ItemStackComponent({
        ...archetype.components.itemStack,
        quantity: snapshot.itemStack?.quantity,
      }));
    }
    if (archetype.components.actorResidency) {
      actor.addComponent(new ActorResidencyComponent({
        ...archetype.components.actorResidency,
        state: snapshot.residency?.state,
      }));
    }
    if (archetype.components.dropMotion) actor.addComponent(new DropMotionComponent(archetype.components.dropMotion));
    if (archetype.components.lifetime) actor.addComponent(new LifetimeComponent(archetype.components.lifetime));
    if (archetype.components.replicationPolicy) {
      actor.addComponent(new ReplicationPolicyComponent(archetype.components.replicationPolicy));
    }
    const clientStack = actor.getComponent(ITEM_STACK_COMPONENT) as ItemStackComponent | undefined;
    const clientFuel = actor.getComponent(COMBUSTIBLE_COMPONENT) as CombustibleComponent | undefined;
    if (clientStack && clientFuel) {
      clientFuel.maximumFuel *= clientStack.quantity;
      clientFuel.fuel = clientFuel.maximumFuel;
    }
    actor.addComponent(new ReplicationComponent());

    if (archetype.components.itemStack) {
      if (!archetype.components.render) throw new Error(`物品堆 ${archetype.id} 缺少 render`);
      actor.addComponent(new SimpleCollisionComponent(
        createSimpleCollisionFromRender(archetype.components.render, archetype.components.dropMotion),
      ));
      this.world.addActor(actor);
      return actor;
    }

    // 样式来自已净化的原型、不在快照里，所以随 spawn 一次性给定；
    // 每帧过边界的只有路点、当前节点与开关（见 ActorGuidePathSyncSystem）。
    const guidePathStyle = archetype.components.guidePath
      ? {
        lineColor: archetype.components.guidePath.lineColor ?? '#fffdf4',
        markerColor: archetype.components.guidePath.markerColor ?? '#fffdf4',
        lineWidth: archetype.components.guidePath.lineWidth ?? 5,
        dashLength: archetype.components.guidePath.dashLength ?? 0.8,
        gapLength: archetype.components.guidePath.gapLength ?? 0.55,
        dashSpeed: archetype.components.guidePath.dashSpeed ?? 0.5,
        markerSize: archetype.components.guidePath.markerSize ?? 0.55,
      }
      : undefined;

    if (!archetype.components.render && archetype.components.guidePath) {
      const info = this.renderScene.createMeshProxy({
        name: `actor-${snapshot.id}`,
        guidePath: guidePathStyle,
      });
      actor.addComponent(new RenderProxyComponent(info.id, this.renderScene));
      this.world.addActor(actor);
      return actor;
    }
    if (!archetype.components.render) throw new Error(`可视 Actor ${archetype.id} 缺少 render`);
    // 几何由渲染世界自己从配置生成；Game World 只拿回 proxyId 与几个数值。
    const info = frameTimeline.measure('render-spawn', () => this.renderScene.createMeshProxy({
      name: `actor-${snapshot.id}`,
      render: archetype.components.render,
      // 「要不要标记」是 spawn 时的一次性事实；锚点本来就产在渲染侧，不必回送。
      interactionMarker: Boolean(archetype.components.interactable),
      temperatureMarker: Boolean(archetype.components.temperature),
      guidePath: guidePathStyle,
      // 船体和货箱在原型里互斥（有 buoyancy 的没有 cargo，反之亦然），
      // 所以「哪一种浮动」是一个值而不是两个开关。
      waterMotion: archetype.components.buoyancy
        ? 'hull'
        : (archetype.components.cargo ? 'cargo' : undefined),
    }));
    // proxy 已经占了一个槽位，但要到 addActor 之后才由 RenderProxyComponent 的
    // 生命周期负责回收。这中间任何一步抛出（例如原型声明了 temperature 却没装上
    // 对应 Component），槽位既不在 freeSlots 里也没有 Actor 持有它——泄漏一个
    // 挂在场景图上的模型。所以整段装配包在 try 里，失败就把 proxy 还回去。
    let assembled = false;
    try {
      actor.addComponent(new SimpleCollisionComponent(info.simpleCollision));
      // RenderProxyComponent 必须先于所有表现 Component 加入：Actor.endPlay 是插入
      // 顺序的逆序，marker 要先释放自己的子树，proxy 的 disposeSubtree 才能最后跑。
      actor.addComponent(new RenderProxyComponent(info.id, this.renderScene));
      // 腿的步态整段在渲染侧，玩法侧只负责「脚下的地面有多高」这一项查询。
      if (archetype.components.render.model === 'line-art-legged-slime') {
        actor.addComponent(new LegGroundProbeComponent(
          this.sampleGroundHeight,
          resolveSlimeLegGroundProbeLayout(archetype.components.render),
        ));
      }
      // 软体蒙皮不再挂在 Actor 上：createMeshProxy 认出 PBF 史莱姆就在渲染世界里
      // 自己建一份表现，玩法侧只写 SlimeMotionParams 那几个 f32（§1.5）。
      const render = this.renderScene.resolve(info.id) as ThreeMeshProxy;
      if (render.fireVisualRig) {
        const emitter = actor.getComponent(HEAT_EMITTER_COMPONENT) as HeatEmitterComponent | undefined;
        actor.addComponent(new FireVisualComponent(emitter?.enabled ? 1 : 0));
      }
      this.world.addActor(actor);
      assembled = true;
    } finally {
      // addActor 成功之后 proxy 归 Actor 管；在那之前失败就由这里回收。
      if (!assembled) this.renderScene.destroyMeshProxy(info.id);
    }
    return actor;
  }

  /** 渲染侧查找。拾取、悬停高亮这类仍住在客户端的表现代码经由它取 Object3D。 */
  private resolveRender(actor: Actor): ThreeMeshProxy | undefined {
    const proxy = actor.getComponent(RENDER_PROXY_COMPONENT) as RenderProxyComponent | undefined;
    return proxy ? this.renderScene.resolve(proxy.proxyId) : undefined;
  }

  private applySnapshot(actor: Actor, snapshot: SnapshotActor): void {
    const transform = actor.requireComponent(TRANSFORM_COMPONENT) as TransformComponent;
    const replication = actor.requireComponent(REPLICATION_COMPONENT) as ReplicationComponent;
    if (snapshot.transform) transform.applySnapshot(snapshot.transform, snapshot.localTransform);
    if (snapshot.buoyancy && snapshot.revision >= replication.revision) {
      const buoyancy = actor.requireComponent(BUOYANCY_COMPONENT) as BuoyancyComponent;
      buoyancy.state = snapshot.buoyancy.state;
      buoyancy.draft = snapshot.buoyancy.draft;
      buoyancy.staticRoll = snapshot.buoyancy.staticRoll;
      buoyancy.staticPitch = snapshot.buoyancy.staticPitch;
      buoyancy.speedFactor = snapshot.buoyancy.speedFactor;
      buoyancy.cargoMass = snapshot.buoyancy.cargoMass;
      buoyancy.damagedPartCount = snapshot.buoyancy.damagedPartCount;
      buoyancy.eventRevision = snapshot.buoyancy.eventRevision;
      buoyancy.lastEvent = snapshot.buoyancy.lastEvent ?? undefined;
      buoyancy.dirty = false;
      buoyancy.revision = snapshot.revision;
      replication.revision = snapshot.revision;
    }
    if (snapshot.vessel) {
      const motor = actor.requireComponent(VESSEL_MOTOR_COMPONENT) as VesselMotorComponent;
      motor.speed = snapshot.vessel.speed;
      motor.throttle = snapshot.vessel.throttle;
      motor.steering = snapshot.vessel.steering;
    }
    if (snapshot.control) {
      const control = actor.requireComponent(ACTOR_CONTROL_COMPONENT) as ActorControlComponent;
      control.ownerPlayerId = snapshot.control.ownerPlayerId;
      control.revision = snapshot.control.revision;
    }
    if (snapshot.interactable) {
      const interactable = actor.requireComponent(INTERACTABLE_COMPONENT) as InteractableComponent;
      interactable.enabled = snapshot.interactable.enabled;
      interactable.revision = snapshot.interactable.revision;
    }
    if (snapshot.cargo) {
      const cargo = actor.requireComponent(CARGO_COMPONENT) as CargoComponent;
      cargo.carrierActorId = snapshot.cargo.carrierActorId;
      cargo.revision = snapshot.cargo.revision;
    }
    if (snapshot.elasticTether) {
      const tether = actor.requireComponent(
        ELASTIC_TETHER_COMPONENT,
      ) as ElasticTetherComponent;
      tether.holderPlayerId = snapshot.elasticTether.holderPlayerId;
      tether.targetX = snapshot.elasticTether.targetX;
      tether.targetY = snapshot.elasticTether.targetY;
      tether.targetZ = snapshot.elasticTether.targetZ;
      tether.grabLength = snapshot.elasticTether.grabLength ?? tether.grabLength;
      tether.releaseRevision = snapshot.elasticTether.releaseRevision;
      tether.revision = snapshot.elasticTether.revision;
    }
    if (snapshot.elasticDetach) {
      const detachable = actor.requireComponent(
        ELASTIC_DETACH_COMPONENT,
      ) as ElasticDetachComponent;
      detachable.detached = snapshot.elasticDetach.detached;
      detachable.revision = snapshot.elasticDetach.revision;
      const rotation = snapshot.elasticDetach.rotation;
      if (rotation) {
        const motion = actor.getComponent('dropMotion') as DropMotionComponent | undefined;
        motion?.setRotation({ x: rotation[0], y: rotation[1], z: rotation[2], w: rotation[3] });
      }
      if (detachable.detached && !detachable.dropCollisionApplied) {
        const motion = actor.getComponent('dropMotion') as DropMotionComponent | undefined;
        if (motion) {
          (actor.requireComponent(SIMPLE_COLLISION_COMPONENT) as SimpleCollisionComponent)
            .setDefinition({
              shape: 'cylinder',
              halfWidth: motion.radius,
              halfLength: motion.radius,
              minimumY: -motion.radius,
              maximumY: motion.radius,
            });
          detachable.dropCollisionApplied = true;
        }
      }
    }
    if (snapshot.thermal) {
      const temperature = actor.requireComponent(TEMPERATURE_COMPONENT) as TemperatureComponent;
      temperature.temperature = snapshot.thermal.temperature;
      temperature.revision = snapshot.thermal.revision;
      const combustible = actor.getComponent(COMBUSTIBLE_COMPONENT) as CombustibleComponent | undefined;
      if (combustible) {
        combustible.burning = snapshot.thermal.burning;
        combustible.fuel = combustible.maximumFuel * snapshot.thermal.fuelRatio;
        combustible.revision = snapshot.thermal.revision;
      }
      const fire = actor.getComponent(FIRE_VISUAL_COMPONENT) as FireVisualComponent | undefined;
      if (fire) fire.targetIntensity = snapshot.thermal.burning ? 1 : 0;
    }
    if (snapshot.itemStack) {
      const stack = actor.requireComponent(ITEM_STACK_COMPONENT) as ItemStackComponent;
      stack.quantity = snapshot.itemStack.quantity;
      stack.revision = snapshot.itemStack.revision;
    }
    if (snapshot.residency) {
      const residency = actor.requireComponent(ACTOR_RESIDENCY_COMPONENT) as ActorResidencyComponent;
      residency.state = snapshot.residency.state;
      residency.revision = snapshot.residency.revision;
    }
    if (snapshot.guidePath) {
      const guidePath = actor.requireComponent(GUIDE_PATH_COMPONENT) as GuidePathComponent;
      guidePath.applySnapshot(snapshot.guidePath);
    }
    if (snapshot.propState) {
      this.applyGeneratedPropState(actor, {
        ...snapshot.propState,
        revision: snapshot.propState.revision ?? snapshot.revision,
      });
    }
    replication.revision = Math.max(replication.revision, snapshot.revision);
  }

  private disposeHoverHelper(): void {
    if (!this.hoverHelper) return;
    this.hoverHelper.parent?.remove(this.hoverHelper);
    this.hoverHelper.geometry.dispose();
    (this.hoverHelper.material as THREE.Material).dispose();
    this.hoverHelper = undefined;
    this.hoveredActorId = undefined;
  }

  private createInteractionCandidate(
    actor: Actor,
    interactable: InteractableComponent,
  ): ActorInteractionCandidate {
    const cargo = actor.getComponent(CARGO_COMPONENT) as CargoComponent | undefined;
    const tether = actor.getComponent(
      ELASTIC_TETHER_COMPONENT,
    ) as ElasticTetherComponent | undefined;
    const stack = actor.getComponent(ITEM_STACK_COMPONENT) as ItemStackComponent | undefined;
    return {
      actorId: actor.id,
      label: interactable.label,
      action: interactable.action,
      carrierActorId: cargo?.carrierActorId ?? null,
      holderPlayerId: tether?.holderPlayerId ?? null,
      pickupHolderActorId: this.externalParentActorIds.get(actor.id) ?? null,
      quantity: stack?.quantity,
    };
  }

  private rememberGeneratedPropState(
    actorId: string,
    state: NonNullable<SnapshotActor['propState']>,
    actorRevision: number,
  ): void {
    const identity = parseGeneratedPropId(actorId);
    if (!identity) return;
    const previous = this.generatedPropStates.get(actorId);
    const revision = state.revision ?? actorRevision;
    if (previous && previous.revision > revision) return;
    const copy: PropStateSnapshot = {
      ...state,
      revision,
    };
    this.generatedPropStates.set(actorId, copy);
    this.generatedPropOverrideTarget?.(
      identity.chunkX,
      identity.chunkZ,
      identity.propIndex,
      copy.removed,
    );
  }

  private applyGeneratedPropState(actor: Actor, state: PropStateSnapshot): void {
    const tree = actor.getComponent(GENERATED_PROP_COMPONENT) as GeneratedPropComponent | undefined;
    const interactable = actor.getComponent(INTERACTABLE_COMPONENT) as InteractableComponent | undefined;
    if (!tree || !tree.applySnapshot(state)) return;
    if (interactable) {
      interactable.enabled = !tree.removed;
      interactable.revision = Math.max(interactable.revision, tree.revision);
    }
  }

  /**
   * 生成物件的快照只带 id 与偏离态；id 提供种类和放置地址，世界种子再从带权
   * 配置中确定原型。这条路径不需要重新生成整个 chunk。
   */
  private resolveSnapshotArchetypeId(snapshot: SnapshotActor): string {
    if (snapshot.archetypeId) return snapshot.archetypeId;
    const identity = snapshot.propState ? parseGeneratedPropId(snapshot.id) : undefined;
    const archetype = identity
      ? this.archetypeForGeneratedProp(
          identity.kind,
          identity.chunkX,
          identity.chunkZ,
          identity.propIndex,
        )
      : undefined;
    if (archetype) return archetype.id;
    throw new Error(`Actor ${snapshot.id} 的快照缺少 archetypeId`);
  }

  private archetypeForGeneratedProp(
    kind: number,
    chunkX: number,
    chunkZ: number,
    propIndex: number,
  ): SceneDefinition['actorArchetypes'][number] | undefined {
    return selectWorldPropVariant(
      this.worldSeed,
      kind,
      chunkX,
      chunkZ,
      propIndex,
      this.generatedPropArchetypeVariants.get(kind) ?? [],
    )?.archetype;
  }
}

/** 没有注入渲染世界时（独立使用这个 System 的测试）自己建的那个根节点。 */
function createActorWorldRoot(): THREE.Group {
  const root = new THREE.Group();
  root.name = 'replicated-actor-world';
  return root;
}
