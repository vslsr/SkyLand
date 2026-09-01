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
  ELASTIC_TETHER_COMPONENT,
  ElasticTetherComponent,
  HazardComponent,
  HEAT_EMITTER_COMPONENT,
  HeatEmitterComponent,
  GENERATED_PROP_COMPONENT,
  GeneratedPropComponent,
  INTERACTABLE_COMPONENT,
  InteractableComponent,
  ITEM_STACK_COMPONENT,
  ItemStackComponent,
  LifetimeComponent,
  PlayerMovementComponent,
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
import { PROP_FIELD, PROP_STRIDE } from '../../shared/world/chunkContent.mjs';
import {
  PROP_KIND_BY_NAME,
  formatGeneratedPropId,
  parseGeneratedPropId,
} from '../../shared/world/generatedProp.mjs';
import type { FillMaterialEnvironment } from '../materials/createFillMaterial';
import { createActorVisualModel } from '../models/actors/createActorVisualModel';
import type { SnapshotActor } from '../network/protocol';
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
  THREE_OBJECT_COMPONENT,
  ThreeObjectComponent,
} from './components/ThreeObjectComponent';
import {
  INTERACTION_MARKER_COMPONENT,
  InteractionMarkerComponent,
} from './components/InteractionMarkerComponent';
import { ActorTransformSystem } from './systems/ActorTransformSystem';
import { AttachmentVisualSystem } from './systems/AttachmentVisualSystem';
import { CargoVisualSystem } from './systems/CargoVisualSystem';
import { WaterBobVisualSystem } from './systems/WaterBobVisualSystem';
import { ElasticTetherVisualSystem } from './systems/ElasticTetherVisualSystem';
import {
  FIRE_VISUAL_COMPONENT,
  FireVisualComponent,
} from './components/FireVisualComponent';
import { FireVisualSystem } from './systems/FireVisualSystem';
import { HighCountActorBatchSystem } from './systems/HighCountActorBatchSystem';
import {
  TEMPERATURE_MARKER_COMPONENT,
  TemperatureMarkerComponent,
} from './components/TemperatureMarkerComponent';
import {
  LOCAL_DERIVED_ACTOR_COMPONENT,
  LocalDerivedActorComponent,
} from './components/LocalDerivedActorComponent';

export interface ClientActorSystemOptions {
  definition: SceneDefinition;
  environment: FillMaterialEnvironment;
  now?: () => number;
  /**
   * 场景共用的碰撞世界。传进来时 Actor 与流式 chunk 的碰撞体落在同一张
   * 空间网格上，玩家推出与相机悬臂各查一次就够；不传就自己建一个，
   * 单独使用这个 System 的测试因此不需要额外搭场景。
   */
  collision?: CollisionWorld;
}

type PropStateSnapshot = {
  health: number;
  maximumHealth?: number;
  removed: boolean;
  revision: number;
};
type PropOverrideTarget = (chunkX: number, chunkZ: number, propIndex: number, removed: boolean) => void;

/** 接收服务端完整 Actor 快照并维护对应的客户端 Replica。 */
export class ClientActorSystem implements SceneVisualSystem {
  public readonly root = new THREE.Group();
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
  private readonly highCountBatches: HighCountActorBatchSystem;
  /** actorId → 登记进碰撞世界的实例，逐帧复用，避免每帧产生一批临时对象。 */
  private readonly colliderInstances = new Map<string, {
    collision: SimpleCollisionComponent;
    transform: TransformComponent;
    layers: number;
    actorId: string;
  }>();
  /** 快照换过一批 Actor 之后必须重新登记，置位后由下一次查询或 update 兑现。 */
  private collidersStale = true;
  private hoveredActorId?: string;
  private hoverHelper?: THREE.BoxHelper;
  private simpleCollisionVisible = false;
  private temperatureVisible = false;
  private readonly generatedPropChunks = new Map<string, Set<string>>();
  private readonly generatedPropStates = new Map<string, PropStateSnapshot>();
  private generatedPropOverrideTarget?: PropOverrideTarget;
  /**
   * 物件种类 → 承载它的原型。和服务端一样从场景的 gameplay.worldProps 建表，
   * 两端因此对同一个 id 挑出同一个原型，不需要在快照里带 archetypeId。
   */
  private readonly generatedPropArchetypes = new Map<
    number,
    SceneDefinition['actorArchetypes'][number]
  >();

  public constructor(options: ClientActorSystemOptions) {
    this.root.name = 'replicated-actor-world';
    this.archetypes = new Map(
      options.definition.actorArchetypes.map((definition) => [definition.id, definition]),
    );
    for (const [name, archetypeId] of Object.entries(options.definition.gameplay.worldProps ?? {})) {
      const kind = PROP_KIND_BY_NAME[name];
      const archetype = this.archetypes.get(archetypeId);
      if (kind === undefined || !archetype?.components.generatedProp) continue;
      this.generatedPropArchetypes.set(kind, archetype);
    }
    this.now = options.now ?? (() => Date.now());
    this.collision = options.collision ?? new CollisionWorld();
    this.highCountBatches = new HighCountActorBatchSystem(options.environment, this.archetypes);
    // 客户端不运行 AttachmentSystem：最终世界坐标来自快照插值，不能被
    // localTransform 再次解算覆盖。
    this.world.addSystem(new ActorTransformSystem(this.root));
    if (options.definition.renderer.ocean) {
      this.world.addSystem(new WaterBobVisualSystem(options.definition.renderer.ocean));
      this.world.addSystem(new CargoVisualSystem(options.definition.renderer.ocean));
    }
    this.world.addSystem(new AttachmentVisualSystem());
    this.world.addSystem(new ElasticTetherVisualSystem());
    this.world.addSystem(new FireVisualSystem());
    this.environment = options.environment;
  }

  private readonly environment: FillMaterialEnvironment;

  public syncSnapshots(
    snapshots: readonly SnapshotActor[],
    serverTime: number,
    receivedAt = this.now(),
  ): void {
    this.snapshots.push(snapshots, serverTime, receivedAt);
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
      if (actor.parent?.id !== parentActorId) {
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
      ) this.world.removeActor(actor.id);
    }
    if (this.hoveredActorId && !this.world.getActor(this.hoveredActorId)) {
      this.setHoveredActorId(undefined);
    }
  }

  public update(deltaSeconds: number, elapsedSeconds: number): void {
    this.applySnapshotSet(this.snapshots.sample(this.now()));
    this.world.update(deltaSeconds, elapsedSeconds);
    this.highCountBatches.sync(this.world);
    if (this.highCountBatches.root.children.length > 0 && !this.highCountBatches.root.parent) {
      this.root.add(this.highCountBatches.root);
    }
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
    }
    for (const actorId of Array.from(this.colliderInstances.keys())) {
      if (live.has(actorId)) continue;
      this.colliderInstances.delete(actorId);
      this.collision.removeDynamic(actorId);
    }
  }

  public beforeRender(_renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    for (const actor of this.world.query(INTERACTION_MARKER_COMPONENT) as Actor[]) {
      const marker = actor.requireComponent(
        INTERACTION_MARKER_COMPONENT,
      ) as InteractionMarkerComponent;
      marker.faceCamera(camera);
    }
    if (!this.temperatureVisible) return;
    for (const actor of this.world.query(TEMPERATURE_MARKER_COMPONENT) as Actor[]) {
      const marker = actor.requireComponent(
        TEMPERATURE_MARKER_COMPONENT,
      ) as TemperatureMarkerComponent;
      marker.faceCamera(camera);
    }
  }

  public dispose(): void {
    this.disposeHoverHelper();
    this.snapshots.clear();
    for (const actorId of this.colliderInstances.keys()) this.collision.removeDynamic(actorId);
    this.colliderInstances.clear();
    this.highCountBatches.dispose();
    this.world.dispose();
  }

  public getActor(actorId: string): Actor | undefined {
    return this.world.getActor(actorId) as Actor | undefined;
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
    this.simpleCollisionVisible = visible;
    for (const actor of this.world.query(THREE_OBJECT_COMPONENT) as Actor[]) {
      const render = actor.requireComponent(THREE_OBJECT_COMPONENT) as ThreeObjectComponent;
      render.setSimpleCollisionVisible(visible);
    }
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
    if (this.generatedPropArchetypes.size === 0) return;
    this.unmountGeneratedPropChunk(key);
    const actorIds = new Set<string>();
    for (let propIndex = 0; propIndex < propCount; propIndex += 1) {
      const offset = propIndex * PROP_STRIDE;
      const kind = props[offset + PROP_FIELD.KIND];
      const archetype = this.generatedPropArchetypes.get(kind);
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
          0,
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
    this.temperatureVisible = visible;
    for (const actor of this.world.query(TEMPERATURE_MARKER_COMPONENT) as Actor[]) {
      const marker = actor.requireComponent(
        TEMPERATURE_MARKER_COMPONENT,
      ) as TemperatureMarkerComponent;
      marker.setVisible(visible);
    }
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
      THREE_OBJECT_COMPONENT,
    ) as Actor[]) {
      const interactable = actor.requireComponent(INTERACTABLE_COMPONENT) as InteractableComponent;
      if (!interactable.enabled) continue;
      const render = actor.requireComponent(THREE_OBJECT_COMPONENT) as ThreeObjectComponent;
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

  public setInteractionMarkerActorId(actorId?: string, inputLabel?: string): void {
    // Actor 数量由场景 Schema 固定在 256 以内；标记切换不随世界面积增长。
    for (const actor of this.world.query(INTERACTION_MARKER_COMPONENT) as Actor[]) {
      const marker = actor.requireComponent(
        INTERACTION_MARKER_COMPONENT,
      ) as InteractionMarkerComponent;
      const selected = actor.id === actorId && Boolean(inputLabel);
      marker.setLabel(selected ? inputLabel! : '');
      marker.setVisible(selected);
    }
  }

  public setHoveredActorId(actorId?: string): void {
    if (actorId === this.hoveredActorId) return;
    this.disposeHoverHelper();
    this.hoveredActorId = actorId;
    const actor = actorId ? this.world.getActor(actorId) as Actor | undefined : undefined;
    const render = actor?.getComponent(THREE_OBJECT_COMPONENT) as ThreeObjectComponent | undefined;
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
    if (archetype.components.buoyancy) {
      actor.addComponent(new BuoyancyComponent(archetype.components.buoyancy));
    }
    if (archetype.components.playerMovement) {
      actor.addComponent(new PlayerMovementComponent(archetype.components.playerMovement));
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
        createSimpleCollisionFromRender(archetype.components.render),
      ));
      this.world.addActor(actor);
      return actor;
    }

    if (!archetype.components.render) throw new Error(`可视 Actor ${archetype.id} 缺少 render`);
    const model = createActorVisualModel(this.environment, archetype.components.render);
    model.root.name = `actor-${snapshot.id}-root`;
    model.visualRoot.name = `actor-${snapshot.id}-visual`;
    actor.addComponent(new SimpleCollisionComponent(model.simpleCollision));
    const render = new ThreeObjectComponent(model);
    render.setSimpleCollisionVisible(this.simpleCollisionVisible);
    actor.addComponent(render);
    if (render.fireVisualRig) {
      const emitter = actor.getComponent(HEAT_EMITTER_COMPONENT) as HeatEmitterComponent | undefined;
      actor.addComponent(new FireVisualComponent(render.fireVisualRig, emitter?.enabled ? 1 : 0));
    }
    if (archetype.components.interactable) {
      actor.addComponent(new InteractionMarkerComponent(
        model.root,
        render.interactionAnchorY,
      ));
    }
    if (archetype.components.temperature) {
      const temperature = actor.requireComponent(TEMPERATURE_COMPONENT) as TemperatureComponent;
      const marker = new TemperatureMarkerComponent(
        model.root,
        render.simpleCollision.centerX + render.simpleCollision.halfWidth + 0.42,
        render.interactionAnchorY,
        temperature.temperature,
      );
      marker.setVisible(this.temperatureVisible);
      actor.addComponent(marker);
    }
    this.root.add(model.root);
    this.world.addActor(actor);
    return actor;
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
      tether.releaseRevision = snapshot.elasticTether.releaseRevision;
      tether.revision = snapshot.elasticTether.revision;
    }
    if (snapshot.thermal) {
      const temperature = actor.requireComponent(TEMPERATURE_COMPONENT) as TemperatureComponent;
      temperature.temperature = snapshot.thermal.temperature;
      temperature.revision = snapshot.thermal.revision;
      const temperatureMarker = actor.getComponent(
        TEMPERATURE_MARKER_COMPONENT,
      ) as TemperatureMarkerComponent | undefined;
      temperatureMarker?.setTemperature(snapshot.thermal.temperature);
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
    if (snapshot.propState) {
      this.applyGeneratedPropState(actor, {
        ...snapshot.propState,
        revision: snapshot.propState.revision ?? snapshot.revision,
      });
    }
    replication.revision = Math.max(replication.revision, snapshot.revision);
    const render = actor.getComponent(THREE_OBJECT_COMPONENT) as ThreeObjectComponent | undefined;
    if (render) render.root.userData.floatState = snapshot.buoyancy?.state;
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
   * 生成物件的快照只带 id 与偏离态，原型从 id 里的种类查表得到。
   * 这也是自描述 id 带上种类的理由：这条路径拿不到放置记录。
   */
  private resolveSnapshotArchetypeId(snapshot: SnapshotActor): string {
    if (snapshot.archetypeId) return snapshot.archetypeId;
    const identity = snapshot.propState ? parseGeneratedPropId(snapshot.id) : undefined;
    const archetype = identity ? this.generatedPropArchetypes.get(identity.kind) : undefined;
    if (archetype) return archetype.id;
    throw new Error(`Actor ${snapshot.id} 的快照缺少 archetypeId`);
  }
}
