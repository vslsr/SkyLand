import { serveJobs } from '../platform/WorkerJobRunner';
import {
  runTerrainCollisionJob,
  type TerrainCollisionJob,
  type TerrainCollisionResult,
} from './terrainCollisionJob';

/**
 * 地形碰撞网格的工作线程（实现路径文档 §2 的第 2 项）。
 *
 * 它只认识三样东西：chunk 坐标、世界种子、这一窗里的编辑覆盖。没有 Three、
 * 没有 Rapier、没有场景——地形本来就只由这三样推出来，能搬走的正是这一点。
 */
serveJobs<TerrainCollisionJob, TerrainCollisionResult>((job) => {
  const mesh = runTerrainCollisionJob(job);
  // 顶点和下标是这一趟唯一的大件，转移所有权而不是复制。
  return { result: mesh, transfer: [mesh.vertices.buffer, mesh.indices.buffer] };
});
