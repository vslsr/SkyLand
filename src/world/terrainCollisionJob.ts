import {
  buildTerrainChunkCodes,
  buildTerrainCollisionMeshFromCodes,
} from '../../shared/world/terrainCollisionMesh.mjs';
import { createJobRunner, type JobRunner } from '../platform/WorkerJobRunner';

/**
 * 地形碰撞网格这件活的两端类型与装配（实现路径文档 §2 的第 2 项）。
 *
 * 打点量到 `chunk-terrain-build` p50 约 1.2–1.4 ms，是 chunk 挂载里最贵的那块
 * **纯计算**——`chunk-geometry` 更贵但建的是 Three 对象，第 3 步之前搬不走。
 */
export function runTerrainCollisionJob(job: TerrainCollisionJob): TerrainCollisionResult {
  return buildTerrainCollisionMeshFromCodes(
    job.chunkX,
    job.chunkZ,
    buildTerrainChunkCodes(job.worldSeed, job.chunkX, job.chunkZ, job.overrides),
  );
}

export interface TerrainCollisionJob {
  readonly chunkX: number;
  readonly chunkZ: number;
  readonly worldSeed: number;
  /**
   * 这一窗里的编辑覆盖：`[globalCellX, globalCellZ, code, ...]`，通常是空的。
   *
   * **过边界的是种子和覆盖，不是算好的格子码。** 算格子码本身就不便宜
   * （每格要评估五次程序化底图再哈希一次），主线程先算一遍等于把要搬走的活
   * 留了一半在原地——第一版就是这么写的，打点立刻把它照了出来。
   */
  readonly overrides: Int32Array;
}

export interface TerrainCollisionResult {
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly triangleCount: number;
}

export function createTerrainCollisionRunner(): JobRunner<
  TerrainCollisionJob,
  TerrainCollisionResult
> {
  return createJobRunner<TerrainCollisionJob, TerrainCollisionResult>({
    // 字面量必须留在这里，打包器要看见它才会把 worker 打进产物。
    createWorker: () => new Worker(
      new URL('./terrainCollision.worker.ts', import.meta.url),
      { type: 'module' },
    ),
    runInline: runTerrainCollisionJob,
  });
}
