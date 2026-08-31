import {
  Actor,
  ActorWorld,
  BUOYANCY_COMPONENT,
  BuoyancyComponent,
  TRANSFORM_COMPONENT,
  TransformComponent,
} from '../../shared/actor/index.mjs';
import { BuoyancySystem } from './BuoyancySystem.mjs';

export function createServerActorWorld(sceneDefinition) {
  const world = new ActorWorld({
    seaLevel: sceneDefinition.gameplay?.water?.seaLevel ?? 0,
  });
  world.addSystem(new BuoyancySystem());

  const archetypes = new Map(
    (sceneDefinition.actorArchetypes ?? []).map((definition) => [definition.id, definition]),
  );
  for (const spawn of sceneDefinition.actors ?? []) {
    const archetype = archetypes.get(spawn.archetypeId);
    if (!archetype) throw new Error(`场景 Actor ${spawn.id} 缺少原型：${spawn.archetypeId}`);
    const actor = new Actor(spawn.id, spawn.archetypeId);
    actor.addComponent(new TransformComponent(spawn));
    actor.addComponent(new BuoyancyComponent(archetype.components.buoyancy));
    world.addActor(actor);
  }

  // 出生后立即结算一次，保证首份快照已经包含权威吃水和静态倾斜。
  world.update(0, 0);
  return world;
}

export function createActorSnapshots(world) {
  return world.query(TRANSFORM_COMPONENT).map((actor) => {
    const transform = actor.requireComponent(TRANSFORM_COMPONENT);
    const buoyancy = actor.getComponent(BUOYANCY_COMPONENT);
    return {
      id: actor.id,
      archetypeId: actor.archetypeId,
      revision: buoyancy?.revision ?? 0,
      transform: {
        x: transform.x,
        y: transform.y,
        z: transform.z,
        yaw: transform.yaw,
      },
      ...(buoyancy ? {
        buoyancy: {
          state: buoyancy.state,
          draft: buoyancy.draft,
          staticRoll: buoyancy.staticRoll,
          staticPitch: buoyancy.staticPitch,
          speedFactor: buoyancy.speedFactor,
        },
      } : {}),
    };
  });
}
