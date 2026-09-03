import * as THREE from 'three';
import type { ChunkGenerator } from '../../shared/world/chunkGenerator.mjs';
import { createOverrideCellCodeAt } from '../../shared/world/terrainCollisionMesh.mjs';
import { sampleTerrain } from '../../shared/world/terrainContent.mjs';
import { frameTimeline } from '../platform/index';
import { StreamingGrassSystem, type GrassInteractionTarget } from '../grass';
import type { GrassPatchConfig } from '../grass/grassPatchField';
import type { FillMaterialEnvironment } from '../materials/createFillMaterial';
import { createOceanMaterials, type OceanMaterials } from '../materials/oceanMaterials';
import { createWaterSplashMaterial } from '../materials/createWaterSplashMaterial';
import { OUTLINE_MATERIAL, GROUND_GRID_MATERIAL } from '../materials/lineMaterials';
import {
  createChunkFillMaterial,
  createChunkGroundFillMaterial,
} from '../models/chunkMesh';
import { registerChunkTemplates, type ChunkTemplateOptions } from '../models/chunkTemplates';
import type { SceneUpdateContext } from '../scene/SceneVisualSystem';
import type { OceanVisualDefinition } from '../scenes/data/SceneDefinition';
import { ChunkView } from './ChunkView';
import { createChunkGenerator } from './loadChunkGenerator';

/** 挂一个 chunk 的视图要的东西。全是数据——没有回调、没有 Actor、没有物理。 */
export interface ChunkViewMountRequest {
  readonly key: string;
  readonly chunkX: number;
  readonly chunkZ: number;
  /**
   * 这块 chunk 里被移除的物件位掩码。
   *
   * 几何由这一侧自己按种子生成，但「哪一棵树已经被砍掉」是服务端下发的玩法事实，
   * 推不出来，必须传。
   */
  readonly skipMask?: { low: number; high: number };
  /**
   * 这一窗里被编辑过的格子，摊成 `[globalCellX, globalCellZ, code, ...]`。
   *
   * 地形几何只有两个输入：世界种子（程序化底图，这一侧自己推）和这一小撮覆盖。
   * 传数据而不是传一个读 patch store 的回调，是因为回调过不了线程边界。
   */
  readonly terrainOverrides: Int32Array;
}

/**
 * 玩法侧看到的渲染那一半：**只有命令，没有一个方法有返回值**。
 *
 * `ChunkStreamer` 持有的是这个接口而不是 `ChunkViewHost` 本身——同一个道理，
 * 有返回值就要等对面回话，而线程边界上没有「等一下」。
 * `onGeneratorReady` 是唯一的反向通知，一次性的，不是每帧问一句。
 */
export interface ChunkViewSink {
  mount(request: ChunkViewMountRequest): void;
  unmount(key: string): void;
  clear(): void;
  /** 生成后端就位时回调一次。已经就位则立刻回调。 */
  onGeneratorReady(listener: (kind: string) => void): void;
}

/** 密草只关心这两项；sampleTerrain 写回的其余字段这里用不到。 */
interface GrassAnchorSample {
  groundY: number;
  walkable: boolean;
}

export interface ChunkViewHostOptions {
  templates: ChunkTemplateOptions;
  environment: FillMaterialEnvironment;
  ocean?: OceanVisualDefinition;
  seaLevel?: number;
  worldSeed: number;
  /** 成片密草的生成参数；不给就只画生成器放置的稀疏草簇。 */
  grassPatches?: GrassPatchConfig;
}

/**
 * 流式世界的**渲染那一半**（引擎迁移路线图 第 3 步）。
 *
 * `ChunkStreamer` 原来是三件事合在一个类里：流送规划（玩法）、几何（渲染）、
 * 碰撞体注册（物理）。canvas 交给渲染线程之后这三件要去三个地方，所以先按这条
 * 线切开。
 *
 * 这一半持有：共享材质、海面材质、草地系统，以及每个 chunk 的 `ChunkView`。
 * 它**不知道**流送窗口在哪、哪些 chunk 该加载、地形被谁编辑过——那些是另一半的事。
 * 它只认三条命令：挂上、卸掉、清空。
 *
 * 输入全是数据（类型化数组 + 几个数），所以这一半整体搬进渲染线程时，
 * 命令那一侧不用改。
 */
export class ChunkViewHost implements ChunkViewSink {
  public readonly root = new THREE.Group();
  public readonly grassInteraction?: GrassInteractionTarget;

  private readonly views = new Map<string, ChunkView>();
  private readonly fillMaterial: THREE.Material;
  private readonly groundFillMaterial: THREE.Material;
  private readonly waterMaterials?: OceanMaterials;
  private readonly waterShoreMaterial?: THREE.ShaderMaterial;
  private readonly waterSplashMaterial?: THREE.ShaderMaterial;
  private readonly grass?: StreamingGrassSystem;
  private readonly ocean?: OceanVisualDefinition;
  private readonly templates: ChunkTemplateOptions;
  private readonly worldSeed: number;
  private readonly seaLevel: number;
  /**
   * chunk 几何的生成后端。
   *
   * **它在这一侧，因为它需要 THREE 模板**：`registerChunkTemplates` 把每种物件的
   * 几何烘成模板交给它，`buildChunk` 再照模板把顶点铺出来。玩法侧要的那一半
   * （放置记录）是 `generateChunkProps`——同一个种子、同一份纯函数、不需要模板，
   * 服务端 `ServerGeneratedPropActors` 早就直接调它。两侧各推各的，不用来回送。
   */
  private generator?: ChunkGenerator;
  private disposed = false;
  private readonly generatorReadyListeners: ((kind: string) => void)[] = [];
  /** 复用的地形采样目标：密草每片叶子都要采一次，不为此产生临时对象。 */
  private readonly terrainSample = {} as GrassAnchorSample;

  public constructor(options: ChunkViewHostOptions) {
    this.root.name = 'chunk-views';
    this.templates = options.templates;
    this.ocean = options.ocean;
    this.worldSeed = options.worldSeed;
    this.seaLevel = options.seaLevel ?? 0;
    this.fillMaterial = createChunkFillMaterial(options.environment);
    this.groundFillMaterial = createChunkGroundFillMaterial(options.environment);
    if (options.ocean) {
      this.waterMaterials = createOceanMaterials(options.ocean, this.seaLevel, options.environment);
      this.waterShoreMaterial = this.waterMaterials.grid.clone();
      this.waterShoreMaterial.uniforms.uOpacity.value = Math.min(
        0.9,
        options.ocean.gridLineOpacity * 3.2,
      );
      this.waterSplashMaterial = createWaterSplashMaterial(options.ocean, this.seaLevel);
    }
    if (options.templates.content.grass) {
      this.grass = new StreamingGrassSystem({
        color: options.templates.palette.grass,
        environment: options.environment,
        patches: options.grassPatches,
      });
      this.grassInteraction = this.grass.interaction;
      this.root.add(this.grass.root);
    }

    // 生成后端是异步取回来的；在它就位之前什么都不建，世界会晚一两帧出现，
    // 这比先用一套参数铺一遍再重铺要划算。
    void createChunkGenerator().then((generator) => {
      if (this.disposed) return;
      // 草继续由生成器产出同一批放置记录，但不再烘进静态 chunk；
      // StreamingGrassSystem 会按这些原坐标生成可交互的实例叶片。
      registerChunkTemplates(generator, {
        ...options.templates,
        content: { ...options.templates.content, grass: false },
      });
      generator.setSeed(this.worldSeed);
      this.generator = generator;
      for (const listener of this.generatorReadyListeners) listener(generator.kind);
      this.generatorReadyListeners.length = 0;
    });
  }

  /** 每帧：草地与水面的时间量。和流送规划无关，所以留在这一侧。 */
  public update(
    deltaSeconds: number,
    elapsedSeconds: number,
    context?: SceneUpdateContext,
  ): void {
    this.grass?.update(deltaSeconds, elapsedSeconds, context);
    if (!this.waterMaterials) return;
    this.waterMaterials.surface.uniforms.uTime.value = elapsedSeconds;
    this.waterMaterials.grid.uniforms.uTime.value = elapsedSeconds;
    if (this.waterShoreMaterial) this.waterShoreMaterial.uniforms.uTime.value = elapsedSeconds;
    if (this.waterSplashMaterial) this.waterSplashMaterial.uniforms.uTime.value = elapsedSeconds;
  }

  public beforeRender(renderer: THREE.WebGLRenderer): void {
    this.grass?.beforeRender(renderer);
  }

  public onGeneratorReady(listener: (kind: string) => void): void {
    // 已经就位就立刻回调：装配顺序不该决定玩法侧收不收得到这一条。
    if (this.generator) listener(this.generator.kind);
    else this.generatorReadyListeners.push(listener);
  }

  public mount(request: ChunkViewMountRequest): void {
    if (this.views.has(request.key) || !this.generator) return;
    const cellCodeAt = createOverrideCellCodeAt(this.worldSeed, request.terrainOverrides);
    // 三段分开打点：`chunk-gen` 是纯计算（只是便宜到不值得搬）、`chunk-geometry`
    // 建的是 Three 对象、`chunk-grass` 是草地实例。分开是为了看清哪一段值得动。
    const data = frameTimeline.measure(
      'chunk-gen',
      () => this.generator!.buildChunk(request.chunkX, request.chunkZ, request.skipMask),
    );
    const view = frameTimeline.measure('chunk-geometry', () => new ChunkView(
      request.key,
      request.chunkX,
      request.chunkZ,
      data,
      {
        fill: this.fillMaterial,
        groundFill: this.groundFillMaterial,
        outline: OUTLINE_MATERIAL,
        grid: GROUND_GRID_MATERIAL,
        water: this.waterMaterials,
        waterShore: this.waterShoreMaterial,
        waterSplash: this.waterSplashMaterial,
      },
      {
        worldSeed: this.worldSeed,
        groundColor: this.templates.palette.ground,
        showGround: this.templates.content.ground,
        oceanDefinition: this.ocean,
        seaLevel: this.seaLevel,
        cellCodeAt,
      },
    ));
    frameTimeline.measure('chunk-grass', () => this.grass?.mountChunk(request.key, data, {
      worldSeed: this.worldSeed,
      chunkX: request.chunkX,
      chunkZ: request.chunkZ,
      sampleAnchor: (x, z) => this.sampleGrassAnchor(x, z, cellCodeAt),
    }));
    this.views.set(request.key, view);
    this.root.add(view.root);
  }

  /**
   * 密草的草根高度。水面（含被海平面淹没的地块）不长草，返回 undefined。
   *
   * 采样走的是与地形几何同一套 cellCodeAt，因此编辑过的格子上草也跟着走。
   */
  private sampleGrassAnchor(
    x: number,
    z: number,
    cellCodeAt: (globalCellX: number, globalCellZ: number) => number,
  ): number | undefined {
    const sample = sampleTerrain(
      this.worldSeed,
      x,
      z,
      this.terrainSample,
      cellCodeAt,
    ) as GrassAnchorSample;
    if (!sample.walkable || sample.groundY < this.seaLevel) return undefined;
    return sample.groundY;
  }

  public unmount(key: string): void {
    const view = this.views.get(key);
    if (!view) return;
    this.views.delete(key);
    this.grass?.unmountChunk(key);
    view.dispose();
  }

  public clear(): void {
    for (const key of Array.from(this.views.keys())) this.unmount(key);
  }

  /** 场景卸载时释放这个流式世界独占的显存。 */
  public dispose(): void {
    this.disposed = true;
    this.generator = undefined;
    this.clear();
    this.grass?.dispose();
    this.waterMaterials?.surface.dispose();
    this.waterMaterials?.grid.dispose();
    this.waterShoreMaterial?.dispose();
    this.waterSplashMaterial?.dispose();
    this.fillMaterial.dispose();
    this.groundFillMaterial.dispose();
  }
}
