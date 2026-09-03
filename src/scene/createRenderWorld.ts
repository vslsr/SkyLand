import * as THREE from 'three';
import { createArchetypeTable } from '../render/propInstanceLayout';
import { RenderTransformBuffer } from '../render/RenderTransformBuffer';
import { ThreeRenderScene } from '../render/three/ThreeRenderScene';
import { GrassFieldSystem, type GrassInteractionTarget } from '../grass';
import { createGroundModel } from '../models/ground';
import { createTreeField } from '../models/tree';
import { OceanSystem } from '../ocean/OceanSystem';
import type { SceneDefinition } from '../scenes/data/SceneDefinition';
import { DEFAULT_WORLD_SEED, toWorldSeed } from '../../shared/world/worldConfig.mjs';
import { ChunkViewHost } from '../world/ChunkViewHost';
import { TerrainWorld } from '../world/TerrainWorld';
import { InteractiveParticleEffectHost } from '../particles/InteractiveParticleEffectHost';
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
 * 天气要按地面高度落雨，这一侧因此**自己建一份 `TerrainWorld`**。它是纯数学
 * （不 import three），输入只有种子与海平面，所以两侧各推各的——和 chunk 生成器、
 * 地形覆盖是同一个办法。服务端下发的地形编辑经 `setTerrainCells` 镜像过来，
 * 两份 patch store 因此保持一致。
 *
 * 这里曾经收一个指向玩法侧 `TerrainWorld` 的 `sampleGroundHeight` 回调——
 * 那是渲染侧每帧反向读一次玩法侧，而回调过不了线程边界。
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
  /**
   * 把服务端确认过的地形编辑镜像到这一侧的 patch store。
   *
   * 玩法侧写它自己那一份，同一批格子也要写到这里来——否则雨会落在没被编辑过的
   * 高度上。这是一条**命令**（返回 void），跨线程之后原样变成一条报文。
   */
  setTerrainCells(cells: readonly { cellX: number; cellZ: number; code: number }[]): void;
  /** 场景进出。表现组件靠它挂上／摘下自己的对象，和主线程那批组件同一个语义。 */
  setSceneActive(active: boolean): void;
  /**
   * 这一侧那份地形的高度采样。
   *
   * 地形编辑的高亮框画在这一侧，而它要贴着地面。玩法侧当然也有一份高度，
   * 但**跨边界回读一个数**正是这条边界不做的事——两份地形本来就同源同种子。
   */
  sampleGroundHeight(x: number, z: number): number;
}

export function createRenderWorld(
  definition: SceneDefinition,
  worldSeed?: number,
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

  // 这一侧自己的地形采样。流式地图才有地形；固定地图的地面是一块平板。
  const terrain = renderer.world
    ? new TerrainWorld(
        toWorldSeed(worldSeed ?? DEFAULT_WORLD_SEED),
        definition.gameplay.water?.seaLevel ?? 0,
      )
    : undefined;

  const visualSystems: SceneFrameSystem[] = [];
  /** 需要跟着场景进出而启停的表现组件。 */
  const particleSystems: InteractiveParticleEffectHost[] = [];
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
    sampleGroundHeight: terrain ? (x, z) => terrain.sampleGroundHeight(x, z) : undefined,
  });
  dayNight.setWeatherSource(weather);
  scene.add(dayNight.root);
  scene.add(weather.root);
  visualSystems.push(dayNight, weather);

  // 渲染世界的根总是挂进场景：本地玩家的 proxy 也在它下面，与有没有 Replica 无关。
  const renderWorldRoot = new THREE.Group();
  renderWorldRoot.name = 'render-world';
  const renderScene = new ThreeRenderScene(
    renderWorldRoot,
    environment,
    renderer.ocean,
    // 玩法侧写的是原型下标；这一侧按同一份表反查 render 定义。两边都从
    // `definition` 建，所以顺序必然一致——不需要每帧把这张表塞进通道。
    createArchetypeTable(definition),
  );
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

  // 纯表现的场景组件归这一侧。落叶要的只是几个数和一块地形，没有一样是主线程
  // 独有的；`createSceneRuntimeComponent` 对它返回 undefined，两边不会重复建。
  for (const component of definition.sceneComponents) {
    if (component.type !== 'interactive-particle-effect') continue;
    const particles = new InteractiveParticleEffectHost(component, {
      sceneDefinition: definition,
      worldSeed,
      environmentRuntime: environment.runtime,
      root: renderWorldRoot,
      // TerrainWorld 的订阅口叫 subscribe；这里包一层对上落叶要的那三个方法。
      terrain: terrain && {
        isWaterAt: (x, z) => terrain.isWaterAt(x, z),
        sampleSurfaceHeight: (x, z) => terrain.sampleSurfaceHeight(x, z),
        onTerrainChanged: (listener) => terrain.subscribe(listener),
      },
    });
    visualSystems.push(particles);
    particleSystems.push(particles);
  }

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
    setSceneActive: (active) => {
      for (const particles of particleSystems) {
        if (active) particles.activate();
        else particles.deactivate();
      }
    },
    setTerrainCells: (cells) => {
      for (const cell of cells) terrain?.setCellCode(cell.cellX, cell.cellZ, cell.code);
    },
    sampleGroundHeight: (x, z) => terrain?.sampleGroundHeight(x, z) ?? 0,
  };
}
