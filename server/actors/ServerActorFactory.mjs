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
  HAZARD_COMPONENT,
  HazardComponent,
  AttachmentSystem,
  INTERACTABLE_COMPONENT,
  InteractableComponent,
  SimpleCollisionComponent,
  TRANSFORM_COMPONENT,
  TransformComponent,
  VESSEL_MOTOR_COMPONENT,
  VesselMotorComponent,
} from '../../shared/actor/index.mjs';
import { createSimpleCollisionFromRender } from '../../shared/actor/simpleCollision.mjs';
import { ActorSimpleCollisionSystem } from './ActorSimpleCollisionSystem.mjs';
import { BuoyancySystem } from './BuoyancySystem.mjs';
import { VesselHazardSystem } from './VesselHazardSystem.mjs';
import { VesselMotorSystem } from './VesselMotorSystem.mjs';
import { ElasticTetherSystem } from './ElasticTetherSystem.mjs';

export function createServerActorWorld(sceneDefinition, options = {}) {
  const world = new ActorWorld({
    seaLevel: sceneDefinition.gameplay?.water?.seaLevel ?? 0,
    bounds: sceneDefinition.gameplay?.bounds,
    players: options.players,
  });
  world.addSystem(new BuoyancySystem());
  world.addSystem(new VesselMotorSystem());
  world.addSystem(new ActorSimpleCollisionSystem());
  world.addSystem(new ElasticTetherSystem());
  // 父 Actor 的玩法移动先完成，再统一按拓扑解算所有子 Actor。
  world.addSystem(new AttachmentSystem());
  world.addSystem(new VesselHazardSystem());

  const archetypes = new Map(
    (sceneDefinition.actorArchetypes ?? []).map((definition) => [definition.id, definition]),
  );
  for (const spawn of sceneDefinition.actors ?? []) {
    const archetype = archetypes.get(spawn.archetypeId);
    if (!archetype) throw new Error(`场景 Actor ${spawn.id} 缺少原型：${spawn.archetypeId}`);
    const actor = new Actor(spawn.id, spawn.archetypeId);
    actor.addComponent(new TransformComponent(spawn.localTransform));
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
    // 简易碰撞与可视模型由同一份 render 尺寸派生，不要求作者重复维护边界。
    actor.addComponent(new SimpleCollisionComponent(
      createSimpleCollisionFromRender(archetype.components.render),
    ));
    world.addActor(actor);
  }

  // 先创建全量 Actor，再建立层级，使 JSON 中的父节点不受声明顺序限制。
  for (const spawn of sceneDefinition.actors ?? []) {
    if (spawn.parentActorId) {
      world.setActorParent(spawn.id, spawn.parentActorId, { worldPositionStays: false });
    }
  }
  world.resolveTransforms();

  // 出生后立即结算一次，保证首份快照已经包含权威吃水和静态倾斜。
  world.update(0, 0);
  return world;
}

export function createActorSnapshots(world) {
  return world.query(TRANSFORM_COMPONENT).map((actor) => {
    const transform = actor.requireComponent(TRANSFORM_COMPONENT);
    const buoyancy = actor.getComponent(BUOYANCY_COMPONENT);
    const motor = actor.getComponent(VESSEL_MOTOR_COMPONENT);
    const control = actor.getComponent(ACTOR_CONTROL_COMPONENT);
    const interactable = actor.getComponent(INTERACTABLE_COMPONENT);
    const cargo = actor.getComponent(CARGO_COMPONENT);
    const elasticTether = actor.getComponent(ELASTIC_TETHER_COMPONENT);
    const hazard = actor.getComponent(HAZARD_COMPONENT);
    return {
      id: actor.id,
      archetypeId: actor.archetypeId,
      parentActorId: actor.parent?.id ?? null,
      revision: Math.max(
        buoyancy?.revision ?? 0,
        control?.revision ?? 0,
        interactable?.revision ?? 0,
        cargo?.revision ?? 0,
        elasticTether?.revision ?? 0,
      ),
      transform: {
        x: transform.x,
        y: transform.y,
        z: transform.z,
        yaw: transform.yaw,
      },
      localTransform: {
        x: transform.localX,
        y: transform.localY,
        z: transform.localZ,
        yaw: transform.localYaw,
      },
      ...(buoyancy ? {
        buoyancy: {
          state: buoyancy.state,
          draft: buoyancy.draft,
          staticRoll: buoyancy.staticRoll,
          staticPitch: buoyancy.staticPitch,
          speedFactor: buoyancy.speedFactor,
          cargoMass: buoyancy.loads.reduce((total, load) => total + load.mass, 0),
          damagedPartCount: buoyancy.parts.filter((part) => part.integrity < 1).length,
          eventRevision: buoyancy.eventRevision,
          lastEvent: buoyancy.lastEvent ?? null,
        },
      } : {}),
      ...(motor ? {
        vessel: {
          speed: motor.speed,
          throttle: motor.throttle,
          steering: motor.steering,
        },
      } : {}),
      ...(control ? {
        control: {
          ownerPlayerId: control.ownerPlayerId,
          revision: control.revision,
        },
      } : {}),
      ...(interactable ? {
        interactable: {
          action: interactable.action,
          label: interactable.label,
          enabled: interactable.enabled,
          revision: interactable.revision,
        },
      } : {}),
      ...(cargo ? {
        cargo: {
          mass: cargo.mass,
          carrierActorId: cargo.carrierActorId,
          revision: cargo.revision,
        },
      } : {}),
      ...(elasticTether ? {
        elasticTether: {
          holderPlayerId: elasticTether.holderPlayerId,
          targetX: elasticTether.targetX,
          targetY: elasticTether.targetY,
          targetZ: elasticTether.targetZ,
          releaseRevision: elasticTether.releaseRevision,
          revision: elasticTether.revision,
        },
      } : {}),
      ...(hazard ? {
        hazard: {
          radius: hazard.radius,
        },
      } : {}),
    };
  });
}
