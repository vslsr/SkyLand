import * as THREE from 'three';
import { ClientActorSystem } from '../actors/ClientActorSystem';
import { RenderTransformBuffer } from '../render/RenderTransformBuffer';
import { ThreeRenderScene } from '../render/three/ThreeRenderScene';
import { CollisionWorld } from '../../shared/collision/index.mjs';
import { getRapier, PhysicsWorld } from '../../shared/physics/index.mjs';
import { GrassFieldSystem, type GrassInteractionTarget } from '../grass';
import { createGroundModel } from '../models/ground';
import { createTreeField } from '../models/tree';
import { OceanSystem } from '../ocean/OceanSystem';
import type { SceneDefinition } from '../scenes/data/SceneDefinition';
import { DEFAULT_WORLD_SEED, toWorldSeed } from '../../shared/world/worldConfig.mjs';
import { ChunkStreamer, TerrainWorld } from '../world';
import { WeatherSystem } from '../weather/index';
import { DayNightSystem } from '../environment/index';
import { createSceneEnvironment } from '../materials/createFillMaterial';
import type { SceneComposition, SceneVisualSystem } from './SceneVisualSystem';

export function createLineArtScene(
  definition: SceneDefinition,
  worldSeed?: number,
): SceneComposition {
  const { renderer } = definition;
  const environment = createSceneEnvironment(
    renderer.fog.color,
    renderer.fog.near,
    renderer.fog.far,
  );
  const scene = new THREE.Scene();
  const visualSystems: SceneVisualSystem[] = [];
  // 一个场景一张碰撞网格：流式 chunk 往里放静态物件，Actor 往里放动态盒子，
  // 玩家推出和相机悬臂都只查它，不需要各自再维护一份碰撞体列表。
  const collisionWorld = new CollisionWorld();
  const physicsWorld = new PhysicsWorld(getRapier());
  const terrainWorld = renderer.world
    ? new TerrainWorld(
        toWorldSeed(worldSeed ?? DEFAULT_WORLD_SEED),
        definition.gameplay.water?.seaLevel ?? 0,
      )
    : undefined;
  // 渲染世界归场景所有，不归 ClientActorSystem：本地玩家也要往里建 proxy，
  // 而它不是 Replica（实现路径文档 §1.5 的第 1 条注意）。
  const renderWorldRoot = new THREE.Group();
  renderWorldRoot.name = 'render-world';
  const renderScene = new ThreeRenderScene(renderWorldRoot, environment, renderer.ocean);
  const renderTransforms = new RenderTransformBuffer();
  let grassInteraction: GrassInteractionTarget | undefined;
  // Actor 世界总是建，哪怕这张地图一个 Actor 都没有：**渲染世界那次翻面归它管**
  // （`RenderTransformSyncSystem` 夹在写入与依赖翻面结果的表现 System 之间），
  // 而本地玩家的 proxy 现在也在同一段 SoA 里。按「有没有 Actor」建它，
  // 会让没有 Actor 的地图上玩家整个不动。空的 ActorWorld 每帧什么都不做。
  const actorSnapshotTarget = new ClientActorSystem({
    definition,
    environment,
    collision: collisionWorld,
    physics: physicsWorld,
    worldSeed,
    renderScene,
    transforms: renderTransforms,
    // 长腿 Actor 的落脚采样。没有地形世界的固定地图不传，腿退回自己脚下的平面。
    sampleGroundHeight: terrainWorld
      ? (x, z) => terrainWorld.sampleGroundHeight(x, z)
      : undefined,
  });
  scene.background = new THREE.Color(renderer.background);
  scene.fog = new THREE.Fog(renderer.fog.color, renderer.fog.near, renderer.fog.far);
  // 昼夜先更新：天气要在同一帧里读它算出的天空底色，再合成最终环境。
  const dayNight = new DayNightSystem({
    backgroundColor: renderer.background,
    groundColor: renderer.palette.ground,
    dayNight: definition.environment.dayNight,
  });
  const weather = new WeatherSystem(scene, {
    backgroundColor: renderer.background,
    fogColor: renderer.fog.color,
    fogNear: renderer.fog.near,
    fogFar: renderer.fog.far,
    runtime: environment.runtime,
    sky: dayNight,
    groundColor: renderer.palette.ground,
    sampleGroundHeight: terrainWorld
      ? (x, z) => terrainWorld.sampleGroundHeight(x, z)
      : undefined,
  });
  dayNight.setWeatherSource(weather);
  scene.add(dayNight.root);
  scene.add(weather.root);
  visualSystems.push(dayNight, weather);
  if (renderer.world) {
    // 流式世界接管地面、树、草与岩石：内容由世界种子推导、随焦点进出，
    // content 的开关在这里改为决定 chunk 里放什么。
    //
    const streamer = new ChunkStreamer({
      world: renderer.world,
      worldSeed,
      environment,
      ocean: renderer.content.ocean ? renderer.ocean : undefined,
      seaLevel: definition.gameplay.water?.seaLevel,
      terrainPatches: terrainWorld?.patches,
      collision: collisionWorld,
      physics: physicsWorld,
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
    if (renderer.content.ground) {
      const bounds = definition.gameplay.bounds;
      physicsWorld.setActorCollider('__fixed-ground', {
        shape: 'box',
        halfWidth: (bounds.maximumX - bounds.minimumX) * 0.5,
        halfLength: (bounds.maximumZ - bounds.minimumZ) * 0.5,
        minimumY: -0.2,
        maximumY: 0,
        x: (bounds.minimumX + bounds.maximumX) * 0.5,
        y: 0,
        z: (bounds.minimumZ + bounds.maximumZ) * 0.5,
        yaw: 0,
      });
      physicsWorld.step();
    }
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
  if (renderer.content.ocean && !renderer.world) {
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
  // 渲染世界的根总是挂进场景：本地玩家的 proxy 也在它下面，与有没有 Replica 无关。
  scene.add(renderWorldRoot);
  // Actor 世界这一项同时驱动渲染世界的那一帧（翻面、兑现、表现动画）——
  // 见 `ClientActorSystem.dispose` 上的注释。
  visualSystems.push(actorSnapshotTarget);
  return {
    scene,
    visualSystems,
    weatherTarget: weather,
    dayNightTarget: dayNight,
    environmentRuntime: environment.runtime,
    grassInteraction,
    actorSnapshotTarget,
    renderScene,
    renderTransforms,
    collisionWorld,
    terrainWorld,
    physicsWorld,
  };
}
