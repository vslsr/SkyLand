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
import { AttachmentVisualSystem } from './systems/AttachmentVisualSystem';
import { CargoVisualSystem } from './systems/CargoVisualSystem';
import { WaterBobVisualSystem } from './systems/WaterBobVisualSystem';
import { ActorDropRollSystem } from './systems/ActorDropRollSystem';
import { ElasticTetherVisualSystem } from './systems/ElasticTetherVisualSystem';
import {
  FIRE_VISUAL_COMPONENT,
  FireVisualComponent,
} from './components/FireVisualComponent';
import { GeneratedPropFruitSystem } from './systems/GeneratedPropFruitSystem';
import { HighCountActorBatchSystem } from './systems/HighCountActorBatchSystem';
import { HybridSlimeVisualComponent } from './components/HybridSlimeVisualComponent';
import { HybridSlimeVisualSystem } from './systems/HybridSlimeVisualSystem';
import {
  LOCAL_DERIVED_ACTOR_COMPONENT,
  LocalDerivedActorComponent,
} from './components/LocalDerivedActorComponent';
import { ActorGuidePathSyncSystem } from './systems/ActorGuidePathSyncSystem';

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
  public readonly root = new THREE.Group();
  /**
   * Game World 与 Render World 之间那条边界（路线图 §2 / 第 1 步）。
   * Actor 手上只有 proxyId；Object3D 全部住在 renderScene 里，
   * 两侧靠 transforms 这段字节通信。
   */
  private readonly transforms = new RenderTransformBuffer();
  private readonly renderScene: ThreeRenderScene;
  private readonly world = new ActorWorld();
  private readonly archetypes: Map<string, SceneDefinition['actorArchetypes'][number]>;
  private readonly snapshots = new ActorSnapshotBuffer();
  private readonly now: () => number;
  private readonly raycaster = new THREE.Raycaster();
  private readonly rayOrigin = new THREE.Vector3();
  private readonly rayDirection = new THREE.Vector3();
  private readonly pointToActor = new THREE.Vector3();
  private readonly actorWorldPoint = new THREE.Vector3();
  private readonly closestRayPoint = new THREE.Vector3();
  private readonly collision: CollisionWorld;
  private readonly physics?: PhysicsWorld;
  private readonly highCountBatches: HighCountActorBatchSystem;
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

  public constructor(options: ClientActorSystemOptions) {
    this.root.name = 'replicated-actor-world';
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
    this.fruit = new GeneratedPropFruitSystem(options.environment, this.archetypes);
    this.renderScene = new ThreeRenderScene(this.root, options.environment);
    // 客户端不运行 AttachmentSystem：最终世界坐标来自快照插值，不能被
    // localTransform 再次解算覆盖。
    //
    // 前两个 System 就是那条边界：ActorTransformSystem 只写 SoA 字节，
    // RenderTransformSyncSystem 翻面并交给渲染世界。后面所有表现 System 读的都是
    // 已经摆好位置的 matrixWorld，所以这两个必须排在最前且相邻。
    this.world.addSystem(new ActorTransformSystem(this.transforms));
    // 参数要和 transform 同一次翻面，所以必须夹在写入与 publish 之间。
    this.world.addSystem(new ActorVisualParamSystem(this.transforms));
    this.world.addSystem(new RenderTransformSyncSystem(this.transforms, this.renderScene));
    this.world.addSystem(new ActorGuidePathSyncSystem(this.renderScene));
    this.world.addSystem(new HybridSlimeVisualSystem());
    if (options.definition.renderer.ocean) {
      this.world.addSystem(new WaterBobVisualSystem(this.renderScene, options.definition.renderer.ocean));
      this.world.addSystem(new CargoVisualSystem(this.renderScene, options.definition.renderer.ocean));
    }
    this.world.addSystem(new AttachmentVisualSystem(this.renderScene));
    this.world.addSystem(new ElasticTetherVisualSystem(this.renderScene));
    // 必须排在弹性拉伸之后：脱落物件的姿态由这一步覆盖成刚体朝向。
    this.world.addSystem(new ActorDropRollSystem(this.renderScene));
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

    // Pass 1：先创建完整集合，确保父节点可以出现在快照的任意位置。
    for (const snapshot of applicableSnapshots) {
      let actor = this.world.getActor(snapshot.id) as Actor | undefined;
      const archetypeId = this.resolveSnapshotArchetypeId(snapshot);
      if (actor && actor.archetypeId !== archetypeId) {
        this.world.removeActor(actor.id);
        actor = undefined;
      }
      actor ??= this.createReplica(snapshot);
      if (!actor.hasComponents(REPLICATION_COMPONENT)) {
        actor.addComponent(new ReplicationComponent());
      }
    }

    // Pass 2：父子关系是离散状态，直接采用当前采样快照的目标值。
    for (const snapshot of applicableSnapshots) {
      const actor = this.world.getActor(snapshot.id) as Actor;
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
      this.applySnapshot(this.world.getActor(snapshot.id) as Actor, snapshot);
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
    this.applySnapshotSet(this.snapshots.sample(this.now()));
    this.world.update(deltaSeconds, elapsedSeconds);
    this.highCountBatches.sync(this.world);
    // 果子的熟没熟由绝对服务端时间决定，所以这里用换算过的服务端时钟，
    // 而不是本地 Date.now()。
    const serverTime = this.snapshots.serverTimeAt(this.now());
    this.fruit.sync(this.world, serverTime === undefined ? undefined : serverTime / 1000);
    // 和高数量批次一样按需挂进场景：没有果树的地图不会多出一层空节点。
    if (this.fruit.instanceCount > 0 && !this.fruit.root.parent) this.root.add(this.fruit.root);
    if (this.highCountBatches.root.children.length > 0 && !this.highCountBatches.root.parent) {
      this.root.add(this.highCountBatches.root);
    }
    // 渲染世界自己的表现系统。它们读的是刚翻面的参数段，所以排在 world.update 之后。
    // deltaSeconds 目前仍来自模拟侧——第 3 步渲染进 worker 后换成渲染线程的时钟。
    this.renderScene.updateVisuals(this.transforms, deltaSeconds, elapsedSeconds);
    this.publishColliders();
    this.hoverHelper?.update();
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

  public beforeRender(_renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    this.renderScene.setGuidePathResolution(
      _renderer.domElement.width,
      _renderer.domElement.height,
    );
    // 世界 UI 的朝向是渲染世界自己的事；这里只负责把相机递过去。
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

  public pickInteractableActor(
    origin: readonly [number, number, number],
    direction: readonly [number, number, number],
    maximumDistance = 30,
  ): ActorInteractionCandidate | undefined {
    this.rayOrigin.set(...origin);
    this.rayDirection.set(...direction).normalize();
    this.raycaster.set(this.rayOrigin, this.rayDirection);
    this.raycaster.near = 0;
    this.raycaster.far = maximumDistance;
    this.raycaster.params.Line = { threshold: 0.08 };
    let nearest: { distance: number; candidate: ActorInteractionCandidate } | undefined;
    for (const actor of this.world.query(
      INTERACTABLE_COMPONENT,
      RENDER_PROXY_COMPONENT,
    ) as Actor[]) {
      const interactable = actor.requireComponent(INTERACTABLE_COMPONENT) as InteractableComponent;
      if (!interactable.enabled) continue;
      const render = this.resolveRender(actor);
      if (!render) continue;
      render.root.updateWorldMatrix(true, true);
      const hit = this.raycaster.intersectObject(render.root, true)[0];
      if (!hit || (nearest && hit.distance >= nearest.distance)) continue;
      nearest = {
        distance: hit.distance,
        candidate: this.createInteractionCandidate(actor, interactable),
      };
    }
    // 合批 Actor 没有独立 Object3D；用权威 Transform + 碰撞半径做解析射线命中。
    for (const actor of this.world.query(
      INTERACTABLE_COMPONENT,
      TRANSFORM_COMPONENT,
      ITEM_STACK_COMPONENT,
    ) as Actor[]) {
      const interactable = actor.requireComponent(INTERACTABLE_COMPONENT) as InteractableComponent;
      if (!interactable.enabled) continue;
      const transform = actor.requireComponent(TRANSFORM_COMPONENT) as TransformComponent;
      const collision = actor.requireComponent(SIMPLE_COLLISION_COMPONENT) as SimpleCollisionComponent;
      this.actorWorldPoint.set(
        transform.x,
        transform.y + (collision.minimumY + collision.maximumY) * 0.5,
        transform.z,
      );
      this.pointToActor.copy(this.actorWorldPoint).sub(this.rayOrigin);
      const distance = this.pointToActor.dot(this.rayDirection);
      if (distance < 0 || distance > maximumDistance || (nearest && distance >= nearest.distance)) continue;
      this.closestRayPoint.copy(this.rayDirection).multiplyScalar(distance).add(this.rayOrigin);
      const radius = Math.max(collision.halfWidth, collision.halfLength, 0.2);
      if (this.closestRayPoint.distanceToSquared(this.actorWorldPoint) > radius * radius) continue;
      nearest = { distance, candidate: this.createInteractionCandidate(actor, interactable) };
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
    const info = this.renderScene.createMeshProxy({
      name: `actor-${snapshot.id}`,
      render: archetype.components.render,
      // 「要不要标记」是 spawn 时的一次性事实；锚点本来就产在渲染侧，不必回送。
      interactionMarker: Boolean(archetype.components.interactable),
      temperatureMarker: Boolean(archetype.components.temperature),
      guidePath: guidePathStyle,
    });
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
      const render = this.renderScene.resolve(info.id) as ThreeMeshProxy;
      if (
        archetype.components.render.model === 'line-art-pbf-slime'
        && render.pbfSlimeVisualRig
      ) {
        actor.addComponent(new HybridSlimeVisualComponent(
          render.pbfSlimeVisualRig,
          archetype.components.render,
        ));
      }
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
