import * as THREE from 'three';
import type { ChunkGenerator } from '../../shared/world/chunkGenerator.mjs';
import { toChunkCoordinate } from '../../shared/world/chunkKey.mjs';
import { planChunkStream } from '../../shared/world/chunkStream.mjs';
import {
  CHUNK_BUILD_BUDGET_PER_FRAME,
  DEFAULT_WORLD_SEED,
  toWorldSeed,
} from '../../shared/world/worldConfig.mjs';
import { ChunkView } from './ChunkView';

interface PendingChunk {
  chunkX: number;
  chunkZ: number;
  key: string;
}

/**
 * 按焦点位置流式加载 chunk。
 *
 * 两条纪律决定了它能不能扛住大世界：
 *
 * 1. **只在跨过 chunk 边界时重新规划。** 在同一个 chunk 里走动不需要做任何
 *    集合运算，避免每帧都产生一批临时对象。
 * 2. **每帧只建有限个 chunk。** 玩家高速穿越时一次要补十几个 chunk，
 *    不限额就是一次明显的卡顿；限额之后补齐会晚几帧，但雾效盖住了这段延迟。
 */
export class ChunkStreamer {
  public readonly root = new THREE.Group();

  private readonly views = new Map<string, ChunkView>();
  private pending: PendingChunk[] = [];
  private generator?: ChunkGenerator;
  private worldSeed = toWorldSeed(DEFAULT_WORLD_SEED);
  private centerX?: number;
  private centerZ?: number;

  public constructor() {
    this.root.name = 'chunk-streamer';
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
   * 接入生成后端。WASM 是异步加载的，接入之前 update 不做任何事，
   * 世界会晚一帧出现——比先用 JS 建一遍再用 WASM 重建一遍要划算。
   */
  public setGenerator(generator: ChunkGenerator): void {
    this.generator = generator;
    generator.setSeed(this.worldSeed);
    this.rebuild();
  }

  /** 切换世界种子。种子变了就是另一个世界，已经建好的 chunk 全部作废。 */
  public setWorldSeed(seed: number): void {
    const next = toWorldSeed(seed);
    if (next === this.worldSeed) return;
    this.worldSeed = next;
    this.generator?.setSeed(next);
    this.rebuild();
  }

  /**
   * 每帧调用，focus 通常是玩家位置；还没有玩家时用飞行相机的位置，
   * 这样大厅里看到的也是一片正常的世界。
   */
  public update(focusX: number, focusZ: number): void {
    if (!this.generator) return;

    const centerX = toChunkCoordinate(focusX);
    const centerZ = toChunkCoordinate(focusZ);
    if (centerX !== this.centerX || centerZ !== this.centerZ) {
      this.centerX = centerX;
      this.centerZ = centerZ;
      const plan = planChunkStream({ focusX, focusZ, loadedKeys: this.views.keys() });
      for (const key of plan.unload) this.unmount(key);
      this.pending = plan.load;
    }

    this.drainBuildBudget();
  }

  public dispose(): void {
    this.rebuild();
    this.generator = undefined;
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
  private rebuild(): void {
    for (const key of Array.from(this.views.keys())) this.unmount(key);
    this.pending = [];
    this.centerX = undefined;
    this.centerZ = undefined;
  }
}
