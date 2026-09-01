import * as THREE from 'three';
import type { ChunkGenerator } from '../../shared/world/chunkGenerator.mjs';
import { parseChunkKey, toChunkCoordinate, toChunkKey } from '../../shared/world/chunkKey.mjs';
import { planChunkStream } from '../../shared/world/chunkStream.mjs';
import { TerrainPatchStore } from '../../shared/world/terrainPatches.mjs';
import { TerrainEditor } from '../../shared/world/terrainEditing.mjs';
import {
  CHUNK_BUILD_BUDGET_PER_FRAME,
  DEFAULT_WORLD_SEED,
  toWorldSeed,
} from '../../shared/world/worldConfig.mjs';
import type { CollisionWorld } from '../../shared/collision/index.mjs';
import type { PhysicsWorld } from '../../shared/physics/PhysicsWorld.mjs';
import { buildTerrainCollisionMesh } from '../../shared/world/terrainCollisionMesh.mjs';
import { simpleCollisionGroupToPhysicsDefinitions } from '../../shared/physics/simpleCollisionToPhysics.mjs';
import { readChunkColliders } from '../../shared/world/chunkColliders.mjs';
import {
  isPropSkipped,
  setPropSkipped as updatePropSkipMask,
} from '../../shared/world/generatedProp.mjs';
import { StreamingGrassSystem, type GrassInteractionTarget } from '../grass';
import type { FillMaterialEnvironment } from '../materials/createFillMaterial';
import { createOceanMaterials, type OceanMaterials } from '../materials/oceanMaterials';
import { createWaterSplashMaterial } from '../materials/createWaterSplashMaterial';
import { OUTLINE_MATERIAL, GROUND_GRID_MATERIAL } from '../materials/lineMaterials';
import {
  createChunkFillMaterial,
  createChunkGroundFillMaterial,
} from '../models/chunkMesh';
import { registerChunkTemplates, type ChunkTemplateOptions } from '../models/chunkTemplates';
import type { SceneUpdateContext, SceneVisualSystem } from '../scene/SceneVisualSystem';
import type {
  OceanVisualDefinition,
  WorldStreamingDefinition,
} from '../scenes/data/SceneDefinition';
import { ChunkView } from './ChunkView';
import { createChunkGenerator } from './loadChunkGenerator';

interface PendingChunk {
  chunkX: number;
  chunkZ: number;
  key: string;
}

export interface ChunkStreamerOptions {
  world: WorldStreamingDefinition;
  templates: ChunkTemplateOptions;
  environment: FillMaterialEnvironment;
  ocean?: OceanVisualDefinition;
  seaLevel?: number;
  terrainPatches?: TerrainPatchStore;
  /** 房间分配的世界种子。种子决定这一局的世界，缺省时退回默认种子。 */
  worldSeed?: number;
  /**
   * 场景的碰撞世界。chunk 装载时把它的静态碰撞体整组交进去，卸载时整组撤走，
   * 所以参与碰撞的物件数量跟着 keepRadius 走，不跟世界面积走。
   */
  collision?: CollisionWorld;
  physics?: PhysicsWorld;
  onChunkMounted?: (
    key: string,
    chunkX: number,
    chunkZ: number,
    props: Int32Array,
    propCount: number,
  ) => void;
  onChunkUnmounted?: (key: string) => void;
}

interface PropSkipMask {
  low: number;
  high: number;
}

/**
 * 按焦点位置流式加载 chunk 的场景系统。
 *
 * 两条纪律决定了它能不能扛住大世界：
 *
 * 1. **只在跨过 chunk 边界时重新规划。** 在同一个 chunk 里走动不需要做任何
 *    集合运算，避免每帧都产生一批临时对象。
 * 2. **每帧只建有限个 chunk。** 玩家高速穿越时一次要补十几个 chunk，
 *    不限额就是一次明显的卡顿；限额之后补齐会晚几帧，但雾效盖住了这段延迟。
 */
export class ChunkStreamer implements SceneVisualSystem {
  public readonly root = new THREE.Group();
  public readonly grassInteraction?: GrassInteractionTarget;
  public readonly terrainPatches: TerrainPatchStore;
  public readonly terrainEditor: TerrainEditor;

  private readonly world: WorldStreamingDefinition;
  private readonly views = new Map<string, ChunkView>();
  private readonly fillMaterial: THREE.Material;
  private readonly groundFillMaterial: THREE.Material;
  private readonly waterMaterials?: OceanMaterials;
  private readonly waterShoreMaterial?: THREE.ShaderMaterial;
  private readonly waterSplashMaterial?: THREE.ShaderMaterial;
  private readonly ocean?: OceanVisualDefinition;
  private readonly templates: ChunkTemplateOptions;
  private readonly grass?: StreamingGrassSystem;
  private readonly collision?: CollisionWorld;
  private readonly physics?: PhysicsWorld;
  private readonly onChunkMounted?: ChunkStreamerOptions['onChunkMounted'];
  private readonly onChunkUnmounted?: ChunkStreamerOptions['onChunkUnmounted'];
  /** 只保存被动过的 chunk，默认世界仍不占状态内存。 */
  private readonly skipMasks = new Map<string, PropSkipMask>();
  private pending: PendingChunk[] = [];
  private generator?: ChunkGenerator;
  private readonly worldSeed: number;
  private readonly cellCodeAt: (globalCellX: number, globalCellZ: number) => number;
  private readonly unsubscribeTerrainPatches: () => void;
  private centerX?: number;
  private centerZ?: number;
  private disposed = false;

  public constructor(options: ChunkStreamerOptions) {
    this.root.name = 'chunk-streamer';
    this.world = options.world;
    this.collision = options.collision;
    this.physics = options.physics;
    this.onChunkMounted = options.onChunkMounted;
    this.onChunkUnmounted = options.onChunkUnmounted;
    this.templates = options.templates;
    this.ocean = options.ocean;
    this.worldSeed = toWorldSeed(options.worldSeed ?? DEFAULT_WORLD_SEED);
    this.terrainPatches = options.terrainPatches ?? new TerrainPatchStore(this.worldSeed);
    if (this.terrainPatches.worldSeed !== this.worldSeed) {
      throw new Error('ChunkStreamer 与 TerrainPatchStore 必须使用同一 worldSeed');
    }
    const seaLevel = options.seaLevel ?? 0;
    this.terrainEditor = new TerrainEditor(this.terrainPatches, { seaLevel });
    this.cellCodeAt = (globalCellX, globalCellZ) => (
      this.terrainPatches.cellCodeAt(globalCellX, globalCellZ)
    );
    this.unsubscribeTerrainPatches = this.terrainPatches.subscribe((change: {
      affectedChunks: readonly { key: string }[];
    }) => {
      for (const chunk of change.affectedChunks) {
        if (this.views.has(chunk.key)) this.rebuild(chunk.key);
      }
    });
    this.fillMaterial = createChunkFillMaterial(options.environment);
    this.groundFillMaterial = createChunkGroundFillMaterial(options.environment);
    if (options.ocean) {
      this.waterMaterials = createOceanMaterials(
        options.ocean,
        seaLevel,
        options.environment,
      );
      this.waterShoreMaterial = this.waterMaterials.grid.clone();
      this.waterShoreMaterial.uniforms.uOpacity.value = Math.min(
        0.9,
        options.ocean.gridLineOpacity * 3.2,
      );
      this.waterSplashMaterial = createWaterSplashMaterial(
        options.ocean,
        seaLevel,
      );
    }
    if (options.templates.content.grass) {
      this.grass = new StreamingGrassSystem({
        color: options.templates.palette.grass,
        environment: options.environment,
      });
      this.grassInteraction = this.grass.interaction;
      this.root.add(this.grass.root);
    }

    // 生成后端是异步取回来的；在它就位之前 update 不建任何东西，
    // 世界会晚一两帧出现，这比先用一套参数铺一遍再重铺要划算。
    void createChunkGenerator().then((generator) => {
      if (this.disposed) return;
      // 草继续由生成器产出同一批放置记录，但不再烘进静态 chunk；
      // StreamingGrassSystem 会按这些原坐标生成可交互的实例叶片。
      registerChunkTemplates(generator, {
        ...options.templates,
        content: { ...options.templates.content, grass: false },
      });
      this.setGenerator(generator);
    });
  }

  /** 当前用的是哪个生成后端，用于 HUD 与排查问题。 */
  public get backendKind(): string {
    return this.generator?.kind ?? 'none';
  }

  public get loadedCount(): number {
    return this.views.size;
  }

  public get pendingCount(): number {
    return this.pending.length;
  }

  public setTerrainCellCode(globalCellX: number, globalCellZ: number, code: number): boolean {
    return this.terrainPatches.setCellCode(globalCellX, globalCellZ, code);
  }

  public resetTerrainCell(globalCellX: number, globalCellZ: number): boolean {
    return this.terrainPatches.resetCell(globalCellX, globalCellZ);
  }

  /** 应用服务端下发的生成物件偏离态；已加载时只重建这一块。 */
  public setPropSkipped(
    chunkX: number,
    chunkZ: number,
    propIndex: number,
    skipped = true,
  ): boolean {
    const key = toChunkKey(chunkX, chunkZ);
    const previous = this.skipMasks.get(key);
    if (isPropSkipped(propIndex, previous) === skipped) return false;
    const next = updatePropSkipMask(previous, propIndex, skipped);
    if (next.low === 0 && next.high === 0) this.skipMasks.delete(key);
    else this.skipMasks.set(key, next);
    if (this.views.has(key)) this.rebuild(key);
    return true;
  }

  /**
   * 每帧调用。焦点通常是玩家位置；还没有玩家时是相机位置，
   * 这样大厅背后看到的也是一片正常的世界。
   */
  public update(deltaSeconds: number, elapsedSeconds: number, context?: SceneUpdateContext): void {
    this.grass?.update(deltaSeconds, elapsedSeconds, context);
    if (this.waterMaterials) {
      this.waterMaterials.surface.uniforms.uTime.value = elapsedSeconds;
      this.waterMaterials.grid.uniforms.uTime.value = elapsedSeconds;
      if (this.waterShoreMaterial) {
        this.waterShoreMaterial.uniforms.uTime.value = elapsedSeconds;
      }
      if (this.waterSplashMaterial) {
        this.waterSplashMaterial.uniforms.uTime.value = elapsedSeconds;
      }
    }
    if (!this.generator || !context) return;

    const centerX = toChunkCoordinate(context.focusX);
    const centerZ = toChunkCoordinate(context.focusZ);
    if (centerX !== this.centerX || centerZ !== this.centerZ) {
      this.centerX = centerX;
      this.centerZ = centerZ;
      const plan = planChunkStream({
        focusX: context.focusX,
        focusZ: context.focusZ,
        loadedKeys: this.views.keys(),
        loadRadius: this.world.loadRadius,
        keepRadius: this.world.keepRadius,
      });
      for (const key of plan.unload) this.unmount(key);
      this.pending = plan.load;
    }

    this.drainBuildBudget();
  }

  public beforeRender(renderer: THREE.WebGLRenderer): void {
    this.grass?.beforeRender(renderer);
  }

  /** 场景卸载时释放这个流式世界独占的显存。 */
  public dispose(): void {
    this.disposed = true;
    this.clearChunks();
    this.grass?.dispose();
    this.waterMaterials?.surface.dispose();
    this.waterMaterials?.grid.dispose();
    this.waterShoreMaterial?.dispose();
    this.waterSplashMaterial?.dispose();
    this.unsubscribeTerrainPatches();
    this.fillMaterial.dispose();
    this.groundFillMaterial.dispose();
    this.skipMasks.clear();
    this.generator = undefined;
  }

  private setGenerator(generator: ChunkGenerator): void {
    this.generator = generator;
    generator.setSeed(this.worldSeed);
    this.clearChunks();
  }

  private drainBuildBudget(): void {
    let budget = CHUNK_BUILD_BUDGET_PER_FRAME;
    while (budget > 0) {
      const next = this.pending.shift();
      if (!next) return;
      if (this.views.has(next.key)) continue;
      if (this.mount(next)) budget -= 1;
    }
  }

  private mount(chunk: PendingChunk): boolean {
    if (!this.generator) return false;
    try {
      const skipMask = this.skipMasks.get(chunk.key);
      const data = this.generator.buildChunk(chunk.chunkX, chunk.chunkZ, skipMask);
      const view = new ChunkView(
        chunk.key,
        chunk.chunkX,
        chunk.chunkZ,
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
          seaLevel: this.terrainEditor.seaLevel,
          cellCodeAt: this.cellCodeAt,
        },
      );
      this.grass?.mountChunk(chunk.key, data);
      // 碰撞体由同一批放置记录派生，和几何体同生共死，不会出现「看得见但撞不到」。
      const chunkColliders = readChunkColliders(data.props, data.propCount, [], {
          skipMask,
          chunkX: chunk.chunkX,
          chunkZ: chunk.chunkZ,
        });
      this.collision?.setStaticGroup(chunk.key, chunkColliders);
      this.physics?.setStaticColliderGroup(
        `props:${chunk.key}`,
        simpleCollisionGroupToPhysicsDefinitions(chunkColliders),
      );
      this.physics?.setChunkCollider(
        chunk.key,
        buildTerrainCollisionMesh(chunk.chunkX, chunk.chunkZ, this.cellCodeAt),
      );
      this.views.set(chunk.key, view);
      this.root.add(view.root);
      this.onChunkMounted?.(
        chunk.key,
        chunk.chunkX,
        chunk.chunkZ,
        data.props,
        data.propCount,
      );
      return true;
    } catch (error) {
      // 单个 chunk 建不出来不该拖垮整个场景，跳过它，下次重新规划时再试。
      console.error(`[world] chunk ${chunk.key} 构建失败`, error);
      return false;
    }
  }

  private unmount(key: string): void {
    const view = this.views.get(key);
    if (!view) return;
    this.views.delete(key);
    this.onChunkUnmounted?.(key);
    this.grass?.unmountChunk(key);
    this.collision?.removeStaticGroup(key);
    this.physics?.removeStaticColliderGroup(`props:${key}`);
    this.physics?.removeChunkCollider(key);
    view.dispose();
  }

  private rebuild(key: string): void {
    const coordinate = parseChunkKey(key);
    if (!coordinate || !this.views.has(key)) return;
    this.unmount(key);
    this.mount({ ...coordinate, key });
  }

  /** 清空全部 chunk 并让下一次 update 重新规划。 */
  private clearChunks(): void {
    for (const key of Array.from(this.views.keys())) this.unmount(key);
    this.pending = [];
    this.centerX = undefined;
    this.centerZ = undefined;
  }
}
