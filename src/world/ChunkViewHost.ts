import * as THREE from 'three';
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
import type { ChunkTemplateOptions } from '../models/chunkTemplates';
import type { SceneUpdateContext } from '../scene/SceneVisualSystem';
import type { OceanVisualDefinition } from '../scenes/data/SceneDefinition';
import { ChunkView } from './ChunkView';

/** 挂一个 chunk 的视图要的东西。全是数据——没有回调、没有 Actor、没有物理。 */
export interface ChunkViewMountRequest {
  readonly key: string;
  readonly chunkX: number;
  readonly chunkZ: number;
  /** 生成器产出的放置记录与几何数据（定长类型化数组）。 */
  readonly data: ChunkGeometryPayload;
  /**
   * 这一窗里被编辑过的格子，摊成 `[globalCellX, globalCellZ, code, ...]`。
   *
   * 地形几何只有两个输入：世界种子（程序化底图，这一侧自己推）和这一小撮覆盖。
   * 传数据而不是传一个读 patch store 的回调，是因为回调过不了线程边界。
   */
  readonly terrainOverrides: Int32Array;
}

type ChunkGeometryPayload = ConstructorParameters<typeof ChunkView>[3];

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
export class ChunkViewHost {
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
  }

  public has(key: string): boolean {
    return this.views.has(key);
  }

  public get mountedCount(): number {
    return this.views.size;
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

  public mount(request: ChunkViewMountRequest): void {
    if (this.views.has(request.key)) return;
    const cellCodeAt = createOverrideCellCodeAt(this.worldSeed, request.terrainOverrides);
    // 两段分开打点：几何体是 Three 对象，草地实例是纯计算。
    const view = frameTimeline.measure('chunk-geometry', () => new ChunkView(
      request.key,
      request.chunkX,
      request.chunkZ,
      request.data,
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
    frameTimeline.measure('chunk-grass', () => this.grass?.mountChunk(
      request.key,
      request.data,
      {
        worldSeed: this.worldSeed,
        chunkX: request.chunkX,
        chunkZ: request.chunkZ,
        sampleAnchor: (x, z) => this.sampleGrassAnchor(x, z, cellCodeAt),
      },
    ));
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
