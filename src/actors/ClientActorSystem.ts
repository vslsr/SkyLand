import * as THREE from 'three';
import {
  Actor,
  ActorWorld,
  BUOYANCY_COMPONENT,
  BuoyancyComponent,
  TRANSFORM_COMPONENT,
  TransformComponent,
} from '../../shared/actor/index.mjs';
import type { FillMaterialEnvironment } from '../materials/createFillMaterial';
import { createBuoyancyRaftModel } from '../models/ocean/createBuoyancyRaftModel';
import type { SnapshotActor } from '../network/protocol';
import type { SceneDefinition } from '../scenes/data/SceneDefinition';
import type { SceneVisualSystem } from '../scene/SceneVisualSystem';
import {
  REPLICATION_COMPONENT,
  ReplicationComponent,
} from './components/ReplicationComponent';
import {
  THREE_OBJECT_COMPONENT,
  ThreeObjectComponent,
} from './components/ThreeObjectComponent';
import { ActorTransformSystem } from './systems/ActorTransformSystem';
import { WaterBobVisualSystem } from './systems/WaterBobVisualSystem';

export interface ClientActorSystemOptions {
  definition: SceneDefinition;
  environment: FillMaterialEnvironment;
}

/** 接收服务端完整 Actor 快照并维护对应的客户端 Replica。 */
export class ClientActorSystem implements SceneVisualSystem {
  public readonly root = new THREE.Group();
  private readonly world = new ActorWorld();
  private readonly archetypes: Map<string, SceneDefinition['actorArchetypes'][number]>;

  public constructor(options: ClientActorSystemOptions) {
    this.root.name = 'replicated-actor-world';
    this.archetypes = new Map(
      options.definition.actorArchetypes.map((definition) => [definition.id, definition]),
    );
    this.world.addSystem(new ActorTransformSystem());
    if (options.definition.renderer.ocean) {
      this.world.addSystem(new WaterBobVisualSystem(options.definition.renderer.ocean));
    }
    this.environment = options.environment;
  }

  private readonly environment: FillMaterialEnvironment;

  public syncSnapshots(snapshots: readonly SnapshotActor[]): void {
    const liveIds = new Set<string>();
    for (const snapshot of snapshots) {
      liveIds.add(snapshot.id);
      let actor = this.world.getActor(snapshot.id) as Actor | undefined;
      if (actor && actor.archetypeId !== snapshot.archetypeId) {
        this.world.removeActor(actor.id);
        actor = undefined;
      }
      actor ??= this.createReplica(snapshot);
      this.applySnapshot(actor, snapshot);
    }
    for (const actor of this.world.actors() as Actor[]) {
      if (!liveIds.has(actor.id)) this.world.removeActor(actor.id);
    }
  }

  public update(deltaSeconds: number, elapsedSeconds: number): void {
    this.world.update(deltaSeconds, elapsedSeconds);
  }

  public dispose(): void {
    this.world.dispose();
  }

  public getActor(actorId: string): Actor | undefined {
    return this.world.getActor(actorId) as Actor | undefined;
  }

  private createReplica(snapshot: SnapshotActor): Actor {
    const archetype = this.archetypes.get(snapshot.archetypeId);
    if (!archetype) throw new Error(`客户端缺少 Actor 原型：${snapshot.archetypeId}`);
    const actor = new Actor(snapshot.id, snapshot.archetypeId);
    actor.addComponent(new TransformComponent({
      position: [snapshot.transform.x, snapshot.transform.y, snapshot.transform.z],
      yaw: snapshot.transform.yaw,
    }));
    actor.addComponent(new BuoyancyComponent(archetype.components.buoyancy));
    actor.addComponent(new ReplicationComponent());

    const model = createBuoyancyRaftModel(this.environment, archetype.components.render);
    model.root.name = `actor-${snapshot.id}-root`;
    model.visualRoot.name = `actor-${snapshot.id}-visual`;
    actor.addComponent(new ThreeObjectComponent(model));
    this.root.add(model.root);
    this.world.addActor(actor);
    return actor;
  }

  private applySnapshot(actor: Actor, snapshot: SnapshotActor): void {
    const transform = actor.requireComponent(TRANSFORM_COMPONENT) as TransformComponent;
    const replication = actor.requireComponent(REPLICATION_COMPONENT) as ReplicationComponent;
    transform.applySnapshot(snapshot.transform);
    if (snapshot.buoyancy && snapshot.revision >= replication.revision) {
      const buoyancy = actor.requireComponent(BUOYANCY_COMPONENT) as BuoyancyComponent;
      buoyancy.state = snapshot.buoyancy.state;
      buoyancy.draft = snapshot.buoyancy.draft;
      buoyancy.staticRoll = snapshot.buoyancy.staticRoll;
      buoyancy.staticPitch = snapshot.buoyancy.staticPitch;
      buoyancy.speedFactor = snapshot.buoyancy.speedFactor;
      buoyancy.dirty = false;
      buoyancy.revision = snapshot.revision;
      replication.revision = snapshot.revision;
    }

    const render = actor.requireComponent(THREE_OBJECT_COMPONENT) as ThreeObjectComponent;
    render.root.userData.floatState = snapshot.buoyancy?.state;
  }
}
