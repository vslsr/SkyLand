import * as THREE from 'three';
import type { ChunkGenerator } from '../../shared/world/chunkGenerator.mjs';
import { toChunkCoordinate } from '../../shared/world/chunkKey.mjs';
import { planChunkStream } from '../../shared/world/chunkStream.mjs';
import {
  CHUNK_BUILD_BUDGET_PER_FRAME,
  DEFAULT_WORLD_SEED,
  toWorldSeed,
} from '../../shared/world/worldConfig.mjs';
import type { FillMaterialEnvironment } from '../materials/createFillMaterial';
import { OUTLINE_MATERIAL, GROUND_GRID_MATERIAL } from '../materials/lineMaterials';
import { createChunkFillMaterial } from '../models/chunkMesh';
import { registerChunkTemplates, type ChunkTemplateOptions } from '../models/chunkTemplates';
import { createChunkGridGeometry } from '../models/ground';
import type { SceneUpdateContext, SceneVisualSystem } from '../scene/SceneVisualSystem';
import type { WorldStreamingDefinition } from '../scenes/data/SceneDefinition';
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
  /** 房间分配的世界种子。种子决定这一局的世界，缺省时退回默认种子。 */
  worldSeed?: number;
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

  private readonly world: WorldStreamingDefinition;
  private readonly views = new Map<string, ChunkView>();
  private readonly fillMaterial: THREE.Material;
  private readonly gridGeometry: THREE.BufferGeometry;
  private pending: PendingChunk[] = [];
  private generator?: ChunkGenerator;
  private readonly worldSeed: number;
  private centerX?: number;
  private centerZ?: number;
  private disposed = false;

  public constructor(options: ChunkStreamerOptions) {
    this.root.name = 'chunk-streamer';
    this.world = options.world;
    this.worldSeed = toWorldSeed(options.worldSeed ?? DEFAULT_WORLD_SEED);
    this.fillMaterial = createChunkFillMaterial(options.environment);
    this.gridGeometry = createChunkGridGeometry();

    // 生成后端是异步取回来的；在它就位之前 update 不建任何东西，
    // 世界会晚一两帧出现，这比先用一套参数铺一遍再重铺要划算。
    void createChunkGenerator().then((generator) => {
      if (this.disposed) return;
      registerChunkTemplates(generator, options.templates);
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

  /**
   * 每帧调用。焦点通常是玩家位置；还没有玩家时是相机位置，
   * 这样大厅背后看到的也是一片正常的世界。
   */
  public update(_deltaSeconds: number, _elapsedSeconds: number, context?: SceneUpdateContext): void {
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

  /** 场景卸载时释放这个流式世界独占的显存。 */
  public dispose(): void {
    this.disposed = true;
    this.clearChunks();
    this.gridGeometry.dispose();
    this.fillMaterial.dispose();
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
      const view = new ChunkView(
        chunk.key,
        chunk.chunkX,
        chunk.chunkZ,
        this.generator.buildChunk(chunk.chunkX, chunk.chunkZ),
        { fill: this.fillMaterial, outline: OUTLINE_MATERIAL, grid: GROUND_GRID_MATERIAL },
        this.gridGeometry,
      );
      this.views.set(chunk.key, view);
      this.root.add(view.root);
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
    view.dispose();
  }

  /** 清空全部 chunk 并让下一次 update 重新规划。 */
  private clearChunks(): void {
    for (const key of Array.from(this.views.keys())) this.unmount(key);
    this.pending = [];
    this.centerX = undefined;
    this.centerZ = undefined;
  }
}
