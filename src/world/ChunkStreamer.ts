import * as THREE from 'three';
import {
  chunkDistance,
  chunkKey,
  listChunksInRadius,
  toChunkCoordinate,
} from '../../shared/chunkCoordinates.mjs';
import { buildChunk, type Chunk } from './ChunkBuilder';

export interface ChunkCuller {
  isBoxVisible(box: THREE.Box3): boolean;
}

export interface ChunkStreamerOptions {
  /** 以玩家所在地块为中心的方形加载半径。 */
  radius?: number;
  /** 每帧最多构建几个地块，用来把生成成本摊到多帧上。 */
  buildsPerFrame?: number;
}

/**
 * 按玩家位置增删地块。
 *
 * 世界是无限的，内容由 worldGen 按地块坐标确定性生成，因此不需要保存，
 * 也不需要在网络上传输——走远再走回来，看到的还是同一批树。
 */
export class ChunkStreamer {
  public readonly root = new THREE.Group();
  private readonly loaded = new Map<string, Chunk>();
  private readonly radius: number;
  private readonly buildsPerFrame: number;
  private pending: Array<{ x: number; z: number }> = [];
  private centerX?: number;
  private centerZ?: number;

  public constructor(options: ChunkStreamerOptions = {}) {
    this.root.name = 'chunk-streamer';
    this.radius = options.radius ?? 2;
    this.buildsPerFrame = options.buildsPerFrame ?? 1;
  }

  public get loadedCount(): number {
    return this.loaded.size;
  }

  public get pendingCount(): number {
    return this.pending.length;
  }

  /** 每帧调用：焦点跨过地块边界时重排队列，然后按预算构建。 */
  public update(worldX: number, worldZ: number): void {
    const { x, z } = toChunkCoordinate(worldX, worldZ);
    if (x !== this.centerX || z !== this.centerZ) {
      this.centerX = x;
      this.centerZ = z;
      this.unloadDistant(x, z);
      this.refreshQueue(x, z);
    }

    for (let built = 0; built < this.buildsPerFrame && this.pending.length > 0; built += 1) {
      this.build(this.pending.shift()!);
    }
  }

  /** 立刻把半径内的地块全部建好，用于进入场景时避免看到空白世界。 */
  public prime(worldX: number, worldZ: number): void {
    const { x, z } = toChunkCoordinate(worldX, worldZ);
    this.centerX = x;
    this.centerZ = z;
    this.unloadDistant(x, z);
    this.refreshQueue(x, z);
    while (this.pending.length > 0) this.build(this.pending.shift()!);
  }

  /** 按包围盒逐地块设置可见性。地块内的物体已经关掉了各自的视锥判定。 */
  public cull(culler: ChunkCuller): void {
    for (const chunk of this.loaded.values()) {
      chunk.group.visible = culler.isBoxVisible(chunk.box);
    }
  }

  public clear(): void {
    for (const chunk of this.loaded.values()) chunk.dispose();
    this.loaded.clear();
    this.pending = [];
    this.centerX = undefined;
    this.centerZ = undefined;
  }

  private build(coordinate: { x: number; z: number }): void {
    const key = chunkKey(coordinate.x, coordinate.z);
    if (this.loaded.has(key)) return;

    const chunk = buildChunk(coordinate.x, coordinate.z);
    this.loaded.set(key, chunk);
    this.root.add(chunk.group);
  }

  private refreshQueue(centerX: number, centerZ: number): void {
    // listChunksInRadius 已经按由近及远排序，离玩家最近的地块先补上。
    this.pending = listChunksInRadius(centerX, centerZ, this.radius).filter(
      (coordinate) => !this.loaded.has(chunkKey(coordinate.x, coordinate.z)),
    );
  }

  private unloadDistant(centerX: number, centerZ: number): void {
    for (const [key, chunk] of this.loaded) {
      if (chunkDistance(centerX, centerZ, chunk.x, chunk.z) <= this.radius) continue;
      chunk.dispose();
      this.loaded.delete(key);
    }
  }
}
