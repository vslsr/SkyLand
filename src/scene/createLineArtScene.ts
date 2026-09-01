import * as THREE from 'three';
import { ClientActorSystem } from '../actors/ClientActorSystem';
import { CollisionWorld } from '../../shared/collision/index.mjs';
import { GrassFieldSystem, type GrassInteractionTarget } from '../grass';
import { createGroundModel } from '../models/ground';
import { createTreeField } from '../models/tree';
import { OceanSystem } from '../ocean/OceanSystem';
import type { SceneDefinition } from '../scenes/data/SceneDefinition';
import { ChunkStreamer } from '../world';
import type { SceneComposition, SceneVisualSystem } from './SceneVisualSystem';

export function createLineArtScene(
  definition: SceneDefinition,
  worldSeed?: number,
): SceneComposition {
  const { renderer } = definition;
  const environment = {
    fogColor: renderer.fog.color,
    fogNear: renderer.fog.near,
    fogFar: renderer.fog.far,
  };
  const scene = new THREE.Scene();
  const visualSystems: SceneVisualSystem[] = [];
  // 一个场景一张碰撞网格：流式 chunk 往里放静态物件，Actor 往里放动态盒子，
  // 玩家推出和相机悬臂都只查它，不需要各自再维护一份碰撞体列表。
  const collisionWorld = new CollisionWorld();
  let grassInteraction: GrassInteractionTarget | undefined;
  let actorSnapshotTarget: ClientActorSystem | undefined;
  if (definition.actors.length > 0 || (definition.gameplay.runtimeActorArchetypes?.length ?? 0) > 0) {
    actorSnapshotTarget = new ClientActorSystem({
      definition,
      environment,
      collision: collisionWorld,
    });
  }
  scene.background = new THREE.Color(renderer.background);
  scene.fog = new THREE.Fog(renderer.fog.color, renderer.fog.near, renderer.fog.far);
  if (renderer.world) {
    // 流式世界接管地面、树、草与岩石：内容由世界种子推导、随焦点进出，
    // content 的开关在这里改为决定 chunk 里放什么。
    //
    const streamer = new ChunkStreamer({
      world: renderer.world,
      worldSeed,
      environment,
      collision: collisionWorld,
      onChunkMounted: (key, chunkX, chunkZ, props, propCount) => {
        actorSnapshotTarget?.mountGeneratedPropChunk(key, chunkX, chunkZ, props, propCount);
      },
      onChunkUnmounted: (key) => actorSnapshotTarget?.unmountGeneratedPropChunk(key),
      templates: {
        content: renderer.content,
        environment,
        palette: {
          ground: renderer.palette.ground,
          grass: renderer.palette.grass,
          treeTrunk: renderer.palette.treeTrunk,
          treeNeedles: renderer.palette.treeNeedles,
          rock: renderer.world.rockColor,
        },
      },
    });
    actorSnapshotTarget?.setGeneratedPropOverrideTarget(
      (chunkX, chunkZ, propIndex, removed) => {
        streamer.setPropSkipped(chunkX, chunkZ, propIndex, removed);
      },
    );
    scene.add(streamer.root);
    visualSystems.push(streamer);
    grassInteraction = streamer.grassInteraction;
  } else {
    if (renderer.content.ground) scene.add(createGroundModel(renderer.palette.ground, environment));
    if (renderer.content.trees) {
      scene.add(createTreeField(
        { trunk: renderer.palette.treeTrunk, needles: renderer.palette.treeNeedles },
        environment,
      ));
    }
    if (renderer.content.grass) {
      const grass = new GrassFieldSystem({
        bounds: definition.gameplay.bounds,
        color: renderer.palette.grass,
        environment,
      });
      scene.add(grass.root);
      visualSystems.push(grass);
      grassInteraction = grass.interaction;
    }
  }
  if (renderer.content.ocean) {
    if (!renderer.ocean || !definition.gameplay.water) {
      throw new Error(`水域场景 ${definition.id} 缺少 ocean 或 gameplay.water 配置`);
    }
    const ocean = new OceanSystem({
      definition: renderer.ocean,
      seaLevel: definition.gameplay.water.seaLevel,
      environment,
    });
    scene.add(ocean.root);
    visualSystems.push(ocean);
  }
  if (actorSnapshotTarget) {
    scene.add(actorSnapshotTarget.root);
    visualSystems.push(actorSnapshotTarget);
  }
  return { scene, visualSystems, grassInteraction, actorSnapshotTarget, collisionWorld };
}
