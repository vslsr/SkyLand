import {
  ACTOR_CONTROL_COMPONENT,
  ACTOR_RESIDENCY_COMPONENT,
  ActorResidencyComponent,
  ActorControlComponent,
  Actor,
  ActorWorld,
  BUILD_GRID_COMPONENT,
  BUILD_PIECE_COMPONENT,
  BuildGridComponent,
  BuildPieceComponent,
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
  ELASTIC_DETACH_COMPONENT,
  ElasticDetachComponent,
  HAZARD_COMPONENT,
  HazardComponent,
  HEALTH_COMPONENT,
  HealthComponent,
  HEAT_EMITTER_COMPONENT,
  HeatEmitterComponent,
  GENERATED_PROP_COMPONENT,
  GeneratedPropComponent,
  GUIDE_PATH_COMPONENT,
  GuidePathComponent,
  AttachmentSystem,
  INTERACTABLE_COMPONENT,
  InteractableComponent,
  CONTAINER_COMPONENT,
  ContainerComponent,
  StowableComponent,
  ITEM_STACK_COMPONENT,
  ItemStackComponent,
  LIFETIME_COMPONENT,
  LifetimeComponent,
  PLAYER_MOVEMENT_COMPONENT,
  PlayerMovementComponent,
  PlayerJumpComponent,
  PatrolPathComponent,
  PICKUP_DROP_COMPONENT,
  PickupDropComponent,
  REPLICATION_POLICY_COMPONENT,
  ReplicationPolicyComponent,
  REPLICATED_COMPONENT,
  ReplicatedComponent,
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
import {
  GameAbilityComponent,
  GameAbilitySystem,
  createHealthAttributes,
} from '../../shared/abilities/index.mjs';
import { VesselHazardSystem } from './VesselHazardSystem.mjs';
import { VesselMotorSystem } from './VesselMotorSystem.mjs';
import { ElasticTetherSystem } from './ElasticTetherSystem.mjs';
import { SoftBodyBiteSystem } from './SoftBodyBiteSystem.mjs';
import { ElasticDetachSystem } from './ElasticDetachSystem.mjs';
import { HealthSystem } from './HealthSystem.mjs';
import { TemperatureSystem } from './TemperatureSystem.mjs';
import { HighCountActorSystem } from './HighCountActorSystem.mjs';
import { GuidePathSystem } from './GuidePathSystem.mjs';
import { PatrolPathSystem } from './PatrolPathSystem.mjs';
import { CHUNK_SIZE } from '../../shared/world/worldConfig.mjs';

export function createServerActor(spawn, archetype, runtime = {}) {
  const actor = new Actor(spawn.id, spawn.archetypeId);
  actor.addComponent(new TransformComponent(spawn.localTransform));
  if (archetype.components.buoyancy) actor.addComponent(new BuoyancyComponent(archetype.components.buoyancy));
  if (archetype.components.playerMovement) actor.addComponent(new PlayerMovementComponent(archetype.components.playerMovement));
  if (archetype.components.playerJump) actor.addComponent(new PlayerJumpComponent(archetype.components.playerJump));
  if (archetype.components.vesselMotor) {
    actor.addComponent(new VesselMotorComponent(archetype.components.vesselMotor));
    actor.addComponent(new ActorControlComponent());
  }
  if (archetype.components.interactable) actor.addComponent(new InteractableComponent(archetype.components.interactable));
  if (archetype.components.cargo) actor.addComponent(new CargoComponent(archetype.components.cargo));
  if (archetype.components.elasticTether) actor.addComponent(new ElasticTetherComponent(archetype.components.elasticTether));
  if (archetype.components.elasticDetach) {
    const detachable = actor.addComponent(new ElasticDetachComponent({
      ...archetype.components.elasticDetach,
      ...runtime.elasticDetach,
    }));
  }
  if (archetype.components.pickupDrop) {
    actor.addComponent(new PickupDropComponent({
      ...archetype.components.pickupDrop,
      ...runtime.pickupDrop,
    }));
  }
  if (archetype.components.hazard) actor.addComponent(new HazardComponent(archetype.components.hazard));
  // 有生命值就得有 GAS：权威血量是 `Health` 属性，Component 只是它的复制面。
  // 玩家 Actor 自己带 GAS（见 ServerPlayerActor），走不到这里。
  if (archetype.components.health) {
    actor.addComponent(new GameAbilityComponent({
      attributes: createHealthAttributes(archetype.components.health.maximum),
    }));
    actor.addComponent(new HealthComponent(archetype.components.health));
  }
  if (archetype.components.temperature) actor.addComponent(new TemperatureComponent(archetype.components.temperature));
  if (archetype.components.combustible) actor.addComponent(new CombustibleComponent(archetype.components.combustible));
  if (archetype.components.heatEmitter) actor.addComponent(new HeatEmitterComponent(archetype.components.heatEmitter));
  if (archetype.components.container) {
    actor.addComponent(new ContainerComponent(archetype.components.container));
  }
  if (archetype.components.stowable) {
    actor.addComponent(new StowableComponent(archetype.components.stowable));
  }
  if (archetype.components.buildPiece) {
    const render = archetype.components.render;
    actor.addComponent(new BuildPieceComponent({
      ...archetype.components.buildPiece,
      // 地基的厚度决定它顶面多高、墙脚落在哪；墙和物件没有这一说。
      thickness: render?.model === 'line-art-build-foundation' ? render.thickness : 0,
      ...runtime.buildPiece,
    }));
  }
  if (archetype.components.buildGrid) {
    actor.addComponent(new BuildGridComponent(archetype.components.buildGrid));
  }
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
  if (archetype.components.generatedProp) {
    actor.addComponent(new GeneratedPropComponent(
      archetype.components.generatedProp,
      runtime.generatedProp,
    ));
  }
  if (archetype.components.patrolPath) {
    actor.addComponent(new PatrolPathComponent(archetype.components.patrolPath));
  }
  if (archetype.components.guidePath) {
    actor.addComponent(new GuidePathComponent({
      ...archetype.components.guidePath,
      ...runtime.guidePath,
    }));
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
  // `collision: false` 是给纯表现体用的（手持物）：它有模型但不该挡住任何人，
  // 也不该出现在碰撞索引里。
  if (archetype.components.render && runtime.collision !== false) {
    actor.addComponent(new SimpleCollisionComponent(createSimpleCollisionFromRender(
      archetype.components.render,
      // 可脱离物在附着阶段仍需保留模型的完整支撑面；真正断裂后由
      // ElasticDetachSystem 原子切换成 dropMotion 的紧凑掉落碰撞。
      archetype.components.elasticDetach ? undefined : archetype.components.dropMotion,
    )));
  }
  if (runtime.replicated !== false) actor.addComponent(new ReplicatedComponent());
  return actor;
}

export function createServerActorWorld(sceneDefinition, options = {}) {
  const world = new ActorWorld({
    seaLevel: sceneDefinition.gameplay?.water?.seaLevel ?? 0,
    bounds: sceneDefinition.gameplay?.bounds,
    players: options.players,
    // 场景共用的空间划分。System 拿它做邻近查询，而不是每次遍历全部 Actor。
    collision: options.collision,
    physics: options.physics,
    groundHeightAt: options.groundHeightAt,
    createActor: createServerActor,
  });
  // 碰撞索引在「Actor 已经移动完」和「tick 结束」两个位置各跑一次，
  // 见 ActorColliderIndex 的说明。
  const colliderIndex = new ActorColliderIndex();
  // 流式 Actor 可能在两个房间 tick 之间因玩家输入而挂载；调用方可在同一输入包
  // 的 KCC 查询前立即发布 collider，避免客户端站上菌盖后被服务端拉回地面。
  world.context.refreshActorColliders = () => colliderIndex.update(world);
  world.addSystem(new GameAbilitySystem());
  world.addSystem(new BuoyancySystem());
  world.addSystem(new VesselMotorSystem());
  // 巡逻要排在 colliderIndex 之前：它移动的是权威 Transform，碰撞体必须跟上，
  // 否则玩家会撞在这只史莱姆上一帧之前的位置上。
  world.addSystem(new PatrolPathSystem());
  world.addSystem(colliderIndex);
  world.addSystem(new ActorSimpleCollisionSystem());
  world.addSystem(new ElasticTetherSystem());
  world.addSystem(new SoftBodyBiteSystem());
  const elasticDetachSystem = new ElasticDetachSystem();
  world.context.syncDetachedPhysics = () => elasticDetachSystem.syncTransforms(world);
  world.addSystem(elasticDetachSystem);
  // 父 Actor 的玩法移动先完成，再统一按拓扑解算所有子 Actor。
  world.addSystem(new AttachmentSystem());
  // 排在温度之前没有讲究，但必须在 tick 里：尸体到点销毁是世界的事，
  // 不是某一次伤害的事。
  world.addSystem(new HealthSystem());
  world.addSystem(new TemperatureSystem());
  world.addSystem(new GuidePathSystem());
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

/** 四元数量化到千分之一：视觉上看不出差别，包里少一半字节。 */
function roundRotation(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

export function createActorSnapshots(world, options = {}) {
  const viewer = options.viewer;
  return world.query(TRANSFORM_COMPONENT, REPLICATED_COMPONENT)
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
    const elasticDetach = actor.getComponent(ELASTIC_DETACH_COMPONENT);
    const holderPickupDrop = actor.parent?.getComponent(PICKUP_DROP_COMPONENT);
    const isPickedUp = holderPickupDrop?.heldActorId === actor.id;
    const dropMotion = actor.getComponent(DROP_MOTION_COMPONENT);
    const hazard = actor.getComponent(HAZARD_COMPONENT);
    const health = actor.getComponent(HEALTH_COMPONENT);
    const temperature = actor.getComponent(TEMPERATURE_COMPONENT);
    const combustible = actor.getComponent(COMBUSTIBLE_COMPONENT);
    const container = actor.getComponent(CONTAINER_COMPONENT);
    const itemStack = actor.getComponent(ITEM_STACK_COMPONENT);
    const residency = actor.getComponent(ACTOR_RESIDENCY_COMPONENT);
    const generatedProp = actor.getComponent(GENERATED_PROP_COMPONENT);
    const guidePath = actor.getComponent(GUIDE_PATH_COMPONENT);
    const buildPiece = actor.getComponent(BUILD_PIECE_COMPONENT);
    // 生成物件的 id 已经携带种类与位置地址。偏离态只发 id + 状态，
    // 默认 Interactable 与最大生命由两端同一原型提供。
    if (generatedProp) {
      return {
        id: actor.id,
        revision: generatedProp.revision,
        propState: {
          removed: generatedProp.removed,
          // 两种采集形态只发各自用得上的那一项：可再生的没有血量，
          // 掉血的没有冷却。发一个恒等于 1 的 health 只会误导后来的人。
          ...(generatedProp.regrowable
            // 绝对服务端秒数。客户端拿它自己判断长回来没有，
            // 所以「恢复」那一刻不需要再发一条快照。
            ? { readyAt: generatedProp.readyAt }
            : { health: generatedProp.health }),
        },
      };
    }
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
        elasticDetach?.revision ?? 0,
        isPickedUp ? holderPickupDrop.revision : 0,
        health?.revision ?? 0,
        temperature?.revision ?? 0,
        combustible?.revision ?? 0,
        itemStack?.revision ?? 0,
        residency?.revision ?? 0,
        guidePath?.revision ?? 0,
        buildPiece?.revision ?? 0,
      ),
      // Attach 状态下客户端由父 Actor 同时刻的坐标与 localTransform 推导位置。
      // 物品的其余 Component 仍照常复制，只有冗余的世界 Transform 被省略。
      ...(!isPickedUp ? { transform: {
        x: transform.x,
        y: transform.y,
        z: transform.z,
        yaw: transform.yaw,
      } } : {}),
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
          // 客户端的拉伸表现要按同一条阈值收放，否则菌柄会先到头、玩家还在走。
          grabLength: elasticTether.grabLength,
          releaseRevision: elasticTether.releaseRevision,
          revision: elasticTether.revision,
        },
      } : {}),
      ...(hazard ? {
        hazard: {
          radius: hazard.radius,
        },
      } : {}),
      // 血量、死亡计数与最近一次变化量一起过网：飘字和死亡动画都是一次性表现，
      // 靠计数变化触发，所以它们必须和血量在同一条快照里，不能各发各的。
      ...(health ? { health: health.snapshot() } : {}),
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
      ...(container ? { container: container.snapshot(viewer?.id) } : {}),
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
      ...(elasticDetach ? {
        elasticDetach: {
          detached: elasticDetach.detached,
          revision: elasticDetach.revision,
          // 脱落后 Transform 的 yaw 不再描述姿态：躺在地上还是立着，由刚体
          // 解算出的四元数决定，所以只有脱落的物件才带这一项。
          ...(elasticDetach.detached && dropMotion ? {
            rotation: [
              roundRotation(dropMotion.rotationX),
              roundRotation(dropMotion.rotationY),
              roundRotation(dropMotion.rotationZ),
              roundRotation(dropMotion.rotationW),
            ],
          } : {}),
        },
      } : {}),
      ...(guidePath ? { guidePath: guidePath.snapshot() } : {}),
      // 放在哪一格是离散状态：客户端靠它重建占位表，不靠世界坐标反推。
      ...(buildPiece ? {
        buildPiece: {
          kind: buildPiece.kind,
          surface: buildPiece.placedSurface,
          cellX: buildPiece.cellX,
          cellZ: buildPiece.cellZ,
          ...(buildPiece.edge ? { edge: buildPiece.edge } : {}),
          revision: buildPiece.revision,
        },
      } : {}),
    };
    });
}
