import * as THREE from 'three';
import { RenderTransformBuffer } from '../render/RenderTransformBuffer';
import { ThreeRenderScene } from '../render/three/ThreeRenderScene';
import { GrassFieldSystem, type GrassInteractionTarget } from '../grass';
import { createGroundModel } from '../models/ground';
import { createTreeField } from '../models/tree';
import { OceanSystem } from '../ocean/OceanSystem';
import type { SceneDefinition } from '../scenes/data/SceneDefinition';
import { DEFAULT_WORLD_SEED, toWorldSeed } from '../../shared/world/worldConfig.mjs';
import { ChunkViewHost } from '../world/ChunkViewHost';
import { WeatherSystem } from '../weather/index';
import { DayNightSystem } from '../environment/index';
import {
  createSceneEnvironment,
  type FillMaterialEnvironment,
} from '../materials/createFillMaterial';
import type { SceneFrameSystem } from './SceneVisualSystem';

/**
 * 一张地图的**渲染世界**（引擎迁移路线图 第 3 步）。
 *
 * 这个函数里的每一样东西都会跟着 canvas 走：`THREE.Scene`、材质、几何、
 * chunk 视图、昼夜与天气、固定地图的地面/树/草/海面。
 *
 * 它的输入基本上只有**场景定义和世界种子**——两个纯数据。没有碰撞世界、没有物理
 * 世界、没有 Actor。这正是「能不能搬进 worker」的判据：如果这个函数需要玩法侧的
 * 对象，那就搬不过去。
 *
 * **唯一的例外是 `sampleGroundHeight`**：天气要按地面高度落雨。它今天是一个指向
 * `TerrainWorld`（玩法侧）的回调，也就是渲染侧每帧反向读一次玩法侧——回调过不了
 * 线程边界。修法和 chunk 生成器、地形覆盖是同一个：地面高度是
 * `(种子, 编辑覆盖)` 的纯函数，渲染侧自己推得出来。留着这个参数是为了让这笔债
 * 在签名上看得见，而不是藏在某个字段里。
 *
 * 反过来，玩法世界拿到的是这里返回的几个**命令口与字节段**：
 * `renderScene`（proxy 命令）、`chunkViews`（挂载命令）、`transforms`（SoA）。
 * 见 `createLineArtScene`。
 */
export interface RenderWorldComposition {
  scene: THREE.Scene;
  environment: FillMaterialEnvironment;
  /** Actor 与玩家 proxy 的渲染世界，以及它那段边界字节。 */
  renderScene: ThreeRenderScene;
  transforms: RenderTransformBuffer;
  /** 流式地图才有。玩法侧的 `ChunkStreamer` 往它发挂载命令。 */
  chunkViews?: ChunkViewHost;
  /** 纯渲染的每帧系统，按更新顺序排好。 */
  visualSystems: SceneFrameSystem[];
  /** 草地弯折的写入口。玩法侧只往里推脉冲，不读。 */
  grassInteraction?: GrassInteractionTarget;
  weatherTarget: WeatherSystem;
  dayNightTarget: DayNightSystem;
}

export interface RenderWorldOptions {
  /** 见上：渲染侧唯一还需要反向读玩法侧的一处。 */
  sampleGroundHeight?: (x: number, z: number) => number;
}

export function createRenderWorld(
  definition: SceneDefinition,
  worldSeed?: number,
  options: RenderWorldOptions = {},
): RenderWorldComposition {
  const { renderer } = definition;
  const environment = createSceneEnvironment(
    renderer.fog.color,
    renderer.fog.near,
    renderer.fog.far,
  );
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(renderer.background);
  scene.fog = new THREE.Fog(renderer.fog.color, renderer.fog.near, renderer.fog.far);

  const visualSystems: SceneFrameSystem[] = [];
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
    sampleGroundHeight: options.sampleGroundHeight,
  });
  dayNight.setWeatherSource(weather);
  scene.add(dayNight.root);
  scene.add(weather.root);
  visualSystems.push(dayNight, weather);

  // 渲染世界的根总是挂进场景：本地玩家的 proxy 也在它下面，与有没有 Replica 无关。
  const renderWorldRoot = new THREE.Group();
  renderWorldRoot.name = 'render-world';
  const renderScene = new ThreeRenderScene(renderWorldRoot, environment, renderer.ocean);
  const transforms = new RenderTransformBuffer();

  let grassInteraction: GrassInteractionTarget | undefined;
  let chunkViews: ChunkViewHost | undefined;
  if (renderer.world) {
    // 流式世界接管地面、树、草与岩石：内容由世界种子推导、随焦点进出。
    chunkViews = new ChunkViewHost({
      worldSeed: toWorldSeed(worldSeed ?? DEFAULT_WORLD_SEED),
      environment,
      ocean: renderer.content.ocean ? renderer.ocean : undefined,
      seaLevel: definition.gameplay.water?.seaLevel,
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
    scene.add(chunkViews.root);
    visualSystems.push(chunkViews);
    grassInteraction = chunkViews.grassInteraction;
  } else {
    if (renderer.content.ground) {
      scene.add(createGroundModel(renderer.palette.ground, environment));
    }
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
  }
  scene.add(renderWorldRoot);

  return {
    scene,
    environment,
    renderScene,
    transforms,
    chunkViews,
    visualSystems,
    grassInteraction,
    weatherTarget: weather,
    dayNightTarget: dayNight,
  };
}
