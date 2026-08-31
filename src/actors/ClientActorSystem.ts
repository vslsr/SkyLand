import * as THREE from 'three';
import {
  ACTOR_CONTROL_COMPONENT,
  ActorControlComponent,
  Actor,
  ActorWorld,
  BUOYANCY_COMPONENT,
  BuoyancyComponent,
  CARGO_COMPONENT,
  CargoComponent,
  ELASTIC_TETHER_COMPONENT,
  ElasticTetherComponent,
  HazardComponent,
  INTERACTABLE_COMPONENT,
  InteractableComponent,
  SIMPLE_COLLISION_COMPONENT,
  SimpleCollisionComponent,
  TRANSFORM_COMPONENT,
  TransformComponent,
  VESSEL_MOTOR_COMPONENT,
  VesselMotorComponent,
} from '../../shared/actor/index.mjs';
import { resolveCircleAgainstSimpleCollisions } from '../../shared/actor/simpleCollision.mjs';
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

export interface ClientActorSystemOptions {
  definition: SceneDefinition;
  environment: FillMaterialEnvironment;
  now?: () => number;
}

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
  private hoveredActorId?: string;
  private hoverHelper?: THREE.BoxHelper;
  private simpleCollisionVisible = false;

  public constructor(options: ClientActorSystemOptions) {
    this.root.name = 'replicated-actor-world';
    this.archetypes = new Map(
      options.definition.actorArchetypes.map((definition) => [definition.id, definition]),
    );
    this.now = options.now ?? (() => Date.now());
    // 客户端不运行 AttachmentSystem：最终世界坐标来自快照插值，不能被
    // localTransform 再次解算覆盖。
    this.world.addSystem(new ActorTransformSystem(this.root));
    if (options.definition.renderer.ocean) {
      this.world.addSystem(new WaterBobVisualSystem(options.definition.renderer.ocean));
      this.world.addSystem(new CargoVisualSystem(options.definition.renderer.ocean));
    }
    this.world.addSystem(new AttachmentVisualSystem());
    this.world.addSystem(new ElasticTetherVisualSystem());
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
    const liveIds = new Set<string>();

    // Pass 1：先创建完整集合，确保父节点可以出现在快照的任意位置。
    for (const snapshot of snapshots) {
      liveIds.add(snapshot.id);
      let actor = this.world.getActor(snapshot.id) as Actor | undefined;
      if (actor && actor.archetypeId !== snapshot.archetypeId) {
        this.world.removeActor(actor.id);
        actor = undefined;
      }
      actor ??= this.createReplica(snapshot);
    }

    // Pass 2：父子关系是离散状态，直接采用当前采样快照的目标值。
    for (const snapshot of snapshots) {
      const actor = this.world.getActor(snapshot.id) as Actor;
      const parentActorId = snapshot.parentActorId ?? undefined;
      if (actor.parent?.id !== parentActorId) {
        this.world.setActorParent(actor.id, parentActorId, { worldPositionStays: true });
      }
    }

    // Pass 3：Component 脚本读取到的 Transform 同时包含局部坐标和世界坐标。
    for (const snapshot of snapshots) {
      this.applySnapshot(this.world.getActor(snapshot.id) as Actor, snapshot);
    }

    for (const actor of this.world.actors() as Actor[]) {
      if (!liveIds.has(actor.id)) this.world.removeActor(actor.id);
    }
    if (this.hoveredActorId && !this.world.getActor(this.hoveredActorId)) {
      this.setHoveredActorId(undefined);
    }
  }

  public update(deltaSeconds: number, elapsedSeconds: number): void {
    this.applySnapshotSet(this.snapshots.sample(this.now()));
    this.world.update(deltaSeconds, elapsedSeconds);
    this.hoverHelper?.update();
  }

  public beforeRender(_renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    for (const actor of this.world.query(INTERACTION_MARKER_COMPONENT) as Actor[]) {
      const marker = actor.requireComponent(
        INTERACTION_MARKER_COMPONENT,
      ) as InteractionMarkerComponent;
      marker.faceCamera(camera);
    }
  }

  public dispose(): void {
    this.disposeHoverHelper();
    this.snapshots.clear();
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
  ): { x: number; z: number } {
    const colliders = (this.world.query(
      TRANSFORM_COMPONENT,
      SIMPLE_COLLISION_COMPONENT,
    ) as Actor[]).map((actor) => ({
      collision: actor.requireComponent(SIMPLE_COLLISION_COMPONENT) as SimpleCollisionComponent,
      transform: actor.requireComponent(TRANSFORM_COMPONENT) as TransformComponent,
    }));
    return resolveCircleAgainstSimpleCollisions(position, radius, colliders);
  }

  public setSimpleCollisionVisible(visible: boolean): void {
    this.simpleCollisionVisible = visible;
    for (const actor of this.world.query(THREE_OBJECT_COMPONENT) as Actor[]) {
      const render = actor.requireComponent(THREE_OBJECT_COMPONENT) as ThreeObjectComponent;
      render.setSimpleCollisionVisible(visible);
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
    return nearest?.candidate;
  }

  public findNearbyInteractableActor(
    position: { x: number; z: number },
  ): ActorInteractionCandidate | undefined {
    let nearest: { distance: number; candidate: ActorInteractionCandidate } | undefined;
    for (const actor of this.world.query(
      INTERACTABLE_COMPONENT,
      TRANSFORM_COMPONENT,
    ) as Actor[]) {
      const interactable = actor.requireComponent(INTERACTABLE_COMPONENT) as InteractableComponent;
      if (!interactable.enabled) continue;
      const transform = actor.requireComponent(TRANSFORM_COMPONENT) as TransformComponent;
      const distance = Math.hypot(transform.x - position.x, transform.z - position.z);
      if (distance > interactable.maximumDistance || (nearest && distance >= nearest.distance)) {
        continue;
      }
      nearest = {
        distance,
        candidate: this.createInteractionCandidate(actor, interactable),
      };
    }
    return nearest?.candidate;
  }

  public setInteractionMarkerActorId(actorId?: string): void {
    // Actor 数量由场景 Schema 固定在 256 以内；标记切换不随世界面积增长。
    for (const actor of this.world.query(INTERACTION_MARKER_COMPONENT) as Actor[]) {
      const marker = actor.requireComponent(
        INTERACTION_MARKER_COMPONENT,
      ) as InteractionMarkerComponent;
      marker.setVisible(actor.id === actorId);
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
    const archetype = this.archetypes.get(snapshot.archetypeId);
    if (!archetype) throw new Error(`客户端缺少 Actor 原型：${snapshot.archetypeId}`);
    const actor = new Actor(snapshot.id, snapshot.archetypeId);
    actor.addComponent(new TransformComponent({
      position: [snapshot.transform.x, snapshot.transform.y, snapshot.transform.z],
      yaw: snapshot.transform.yaw,
    }));
    if (archetype.components.buoyancy) {
      actor.addComponent(new BuoyancyComponent(archetype.components.buoyancy));
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
    actor.addComponent(new ReplicationComponent());

    const model = createActorVisualModel(this.environment, archetype.components.render);
    model.root.name = `actor-${snapshot.id}-root`;
    model.visualRoot.name = `actor-${snapshot.id}-visual`;
    actor.addComponent(new SimpleCollisionComponent(model.simpleCollision));
    const render = new ThreeObjectComponent(model);
    render.setSimpleCollisionVisible(this.simpleCollisionVisible);
    actor.addComponent(render);
    if (archetype.components.interactable) {
      actor.addComponent(new InteractionMarkerComponent(
        model.root,
        render.interactionAnchorY,
      ));
    }
    this.root.add(model.root);
    this.world.addActor(actor);
    return actor;
  }

  private applySnapshot(actor: Actor, snapshot: SnapshotActor): void {
    const transform = actor.requireComponent(TRANSFORM_COMPONENT) as TransformComponent;
    const replication = actor.requireComponent(REPLICATION_COMPONENT) as ReplicationComponent;
    transform.applySnapshot(snapshot.transform, snapshot.localTransform);
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
    const render = actor.requireComponent(THREE_OBJECT_COMPONENT) as ThreeObjectComponent;
    render.root.userData.floatState = snapshot.buoyancy?.state;
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
    return {
      actorId: actor.id,
      label: interactable.label,
      action: interactable.action,
      carrierActorId: cargo?.carrierActorId ?? null,
      holderPlayerId: tether?.holderPlayerId ?? null,
    };
  }
}
