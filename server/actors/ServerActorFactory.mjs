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
  DROP_MOTION_COMPONENT,
  DropMotionComponent,
  COMBUSTIBLE_COMPONENT,
  CombustibleComponent,
  ELASTIC_TETHER_COMPONENT,
  ElasticTetherComponent,
  HAZARD_COMPONENT,
  HazardComponent,
  HEAT_EMITTER_COMPONENT,
  HeatEmitterComponent,
  AttachmentSystem,
  INTERACTABLE_COMPONENT,
  InteractableComponent,
  ITEM_STACK_COMPONENT,
  ItemStackComponent,
  LIFETIME_COMPONENT,
  LifetimeComponent,
  PLAYER_MOVEMENT_COMPONENT,
  PlayerMovementComponent,
  REPLICATION_POLICY_COMPONENT,
  ReplicationPolicyComponent,
  SimpleCollisionComponent,
  TEMPERATURE_COMPONENT,
  TemperatureComponent,
  TRANSFORM_COMPONENT,
  TransformComponent,
  VESSEL_MOTOR_COMPONENT,
  VesselMotorComponent,
} from '../../shared/actor/index.mjs';
import { createSimpleCollisionFromRender } from '../../shared/actor/simpleCollision.mjs';
import { ActorColliderIndex } from './ActorColliderIndex.mjs';
import { ActorSimpleCollisionSystem } from './ActorSimpleCollisionSystem.mjs';
import { BuoyancySystem } from './BuoyancySystem.mjs';
import { VesselHazardSystem } from './VesselHazardSystem.mjs';
import { VesselMotorSystem } from './VesselMotorSystem.mjs';
import { ElasticTetherSystem } from './ElasticTetherSystem.mjs';
import { TemperatureSystem } from './TemperatureSystem.mjs';
import { HighCountActorSystem } from './HighCountActorSystem.mjs';
import { CHUNK_SIZE } from '../../shared/world/worldConfig.mjs';

export function createServerActor(spawn, archetype, runtime = {}) {
  const actor = new Actor(spawn.id, spawn.archetypeId);
  actor.addComponent(new TransformComponent(spawn.localTransform));
  if (archetype.components.buoyancy) actor.addComponent(new BuoyancyComponent(archetype.components.buoyancy));
  if (archetype.components.playerMovement) actor.addComponent(new PlayerMovementComponent(archetype.components.playerMovement));
  if (archetype.components.vesselMotor) {
    actor.addComponent(new VesselMotorComponent(archetype.components.vesselMotor));
    actor.addComponent(new ActorControlComponent());
  }
  if (archetype.components.interactable) actor.addComponent(new InteractableComponent(archetype.components.interactable));
  if (archetype.components.cargo) actor.addComponent(new CargoComponent(archetype.components.cargo));
  if (archetype.components.elasticTether) actor.addComponent(new ElasticTetherComponent(archetype.components.elasticTether));
  if (archetype.components.hazard) actor.addComponent(new HazardComponent(archetype.components.hazard));
  if (archetype.components.temperature) actor.addComponent(new TemperatureComponent(archetype.components.temperature));
  if (archetype.components.combustible) actor.addComponent(new CombustibleComponent(archetype.components.combustible));
  if (archetype.components.heatEmitter) actor.addComponent(new HeatEmitterComponent(archetype.components.heatEmitter));
  if (archetype.components.itemStack) {
    actor.addComponent(new ItemStackComponent({ ...archetype.components.itemStack, ...runtime.itemStack }));
  }
  if (archetype.components.actorResidency) {
    actor.addComponent(new ActorResidencyComponent({
      ...archetype.components.actorResidency,
      ...runtime.actorResidency,
    }));
  }
  if (archetype.components.dropMotion) {
    actor.addComponent(new DropMotionComponent({ ...archetype.components.dropMotion, ...runtime.dropMotion }));
  }
  if (archetype.components.lifetime) {
    actor.addComponent(new LifetimeComponent({
      ...archetype.components.lifetime,
      ...runtime.lifetime,
      spawnedAt: runtime.spawnedAt ?? 0,
    }));
  }
  if (archetype.components.replicationPolicy) {
    actor.addComponent(new ReplicationPolicyComponent(archetype.components.replicationPolicy));
  }
  const temperature = actor.getComponent(TEMPERATURE_COMPONENT);
  const combustible = actor.getComponent(COMBUSTIBLE_COMPONENT);
  const stack = actor.getComponent(ITEM_STACK_COMPONENT);
  if (stack && combustible) {
    combustible.maximumFuel *= stack.quantity;
    combustible.fuel = combustible.maximumFuel;
  }
  if (runtime.thermal && temperature) temperature.temperature = runtime.thermal.temperature ?? temperature.temperature;
  if (runtime.thermal && combustible) {
    combustible.fuel = runtime.thermal.fuel ?? combustible.fuel;
    combustible.burning = runtime.thermal.burning ?? combustible.burning;
  }
  actor.addComponent(new SimpleCollisionComponent(createSimpleCollisionFromRender(archetype.components.render)));
  return actor;
}

export function createServerActorWorld(sceneDefinition, options = {}) {
  const world = new ActorWorld({
    seaLevel: sceneDefinition.gameplay?.water?.seaLevel ?? 0,
    bounds: sceneDefinition.gameplay?.bounds,
    players: options.players,
    // 场景共用的空间划分。System 拿它做邻近查询，而不是每次遍历全部 Actor。
    collision: options.collision,
    createActor: createServerActor,
  });
  // 碰撞索引在「Actor 已经移动完」和「tick 结束」两个位置各跑一次，
  // 见 ActorColliderIndex 的说明。
  const colliderIndex = new ActorColliderIndex();
  world.addSystem(new BuoyancySystem());
  world.addSystem(new VesselMotorSystem());
  world.addSystem(colliderIndex);
  world.addSystem(new ActorSimpleCollisionSystem());
  world.addSystem(new ElasticTetherSystem());
  // 父 Actor 的玩法移动先完成，再统一按拓扑解算所有子 Actor。
  world.addSystem(new AttachmentSystem());
  world.addSystem(new TemperatureSystem());
  const highCountActors = new HighCountActorSystem(options.highCountActors);
  world.context.highCountActors = highCountActors;
  world.addSystem(highCountActors);
  world.addSystem(new VesselHazardSystem());
  // tick 末尾再同步一次：玩家输入在两个 tick 之间结算，那时查询到的必须是
  // AttachmentSystem 解算完之后的最新位置。
  world.addSystem(colliderIndex);

  const archetypes = new Map(
    (sceneDefinition.actorArchetypes ?? []).map((definition) => [definition.id, definition]),
  );
  world.context.archetypes = archetypes;
  for (const spawn of sceneDefinition.actors ?? []) {
    const archetype = archetypes.get(spawn.archetypeId);
    if (!archetype) throw new Error(`场景 Actor ${spawn.id} 缺少原型：${spawn.archetypeId}`);
    const actor = createServerActor(spawn, archetype);
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

export function createActorSnapshots(world, options = {}) {
  const viewer = options.viewer;
  return world.query(TRANSFORM_COMPONENT)
    // 动态玩家 Actor 走独立 players 快照，避免和本地预测实体重复渲染。
    .filter((actor) => !actor.hasComponents(PLAYER_MOVEMENT_COMPONENT))
    .filter((actor) => {
      const policy = actor.getComponent(REPLICATION_POLICY_COMPONENT);
      if (!viewer || !policy || policy.mode === 'always') return true;
      const transform = actor.requireComponent(TRANSFORM_COMPONENT);
      return (
        Math.abs(Math.floor(transform.x / CHUNK_SIZE) - Math.floor(viewer.x / CHUNK_SIZE)) <= policy.radiusChunks
        && Math.abs(Math.floor(transform.z / CHUNK_SIZE) - Math.floor(viewer.z / CHUNK_SIZE)) <= policy.radiusChunks
      );
    })
    .map((actor) => {
    const transform = actor.requireComponent(TRANSFORM_COMPONENT);
    const buoyancy = actor.getComponent(BUOYANCY_COMPONENT);
    const motor = actor.getComponent(VESSEL_MOTOR_COMPONENT);
    const control = actor.getComponent(ACTOR_CONTROL_COMPONENT);
    const interactable = actor.getComponent(INTERACTABLE_COMPONENT);
    const cargo = actor.getComponent(CARGO_COMPONENT);
    const elasticTether = actor.getComponent(ELASTIC_TETHER_COMPONENT);
    const hazard = actor.getComponent(HAZARD_COMPONENT);
    const temperature = actor.getComponent(TEMPERATURE_COMPONENT);
    const combustible = actor.getComponent(COMBUSTIBLE_COMPONENT);
    const itemStack = actor.getComponent(ITEM_STACK_COMPONENT);
    const residency = actor.getComponent(ACTOR_RESIDENCY_COMPONENT);
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
        temperature?.revision ?? 0,
        combustible?.revision ?? 0,
        itemStack?.revision ?? 0,
        residency?.revision ?? 0,
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
      ...(temperature ? {
        thermal: {
          temperature: Math.round(temperature.temperature * 10) / 10,
          burning: combustible?.burning ?? false,
          fuelRatio: combustible
            ? Math.round((combustible.fuel / combustible.maximumFuel) * 1000) / 1000
            : 1,
          revision: Math.max(temperature.revision, combustible?.revision ?? 0),
        },
      } : {}),
      ...(itemStack ? {
        itemStack: {
          itemType: itemStack.itemType,
          displayName: itemStack.displayName,
          quantity: itemStack.quantity,
          maximumQuantity: itemStack.maximumQuantity,
          revision: itemStack.revision,
        },
      } : {}),
      ...(residency ? {
        residency: {
          state: residency.state,
          revision: residency.revision,
        },
      } : {}),
    };
    });
}
