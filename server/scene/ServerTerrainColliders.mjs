import { buildTerrainCollisionMesh } from '../../shared/world/terrainCollisionMesh.mjs';
import { terrainCellCodeAt } from '../../shared/world/terrainContent.mjs';
import { toChunkKey } from '../../shared/world/chunkKey.mjs';
import { toWorldSeed } from '../../shared/world/worldConfig.mjs';
import { ChunkResidency } from './ChunkResidency.mjs';

const DEFAULT_RESIDENT_RADIUS = 1;
const DEFAULT_KEEP_RADIUS = 2;

/** Keeps server terrain trimeshes bounded to the same resident ring as static props. */
export class ServerTerrainColliders {
  constructor(options) {
    this.physics = options.physics;
    this.worldSeed = toWorldSeed(options.worldSeed);
    this.cellCodeAt = options.cellCodeAt
      ?? ((cellX, cellZ) => terrainCellCodeAt(this.worldSeed, cellX, cellZ));
    this.residency = new ChunkResidency({
      enabled: options.enabled !== false,
      residentRadius: options.residentRadius ?? DEFAULT_RESIDENT_RADIUS,
      keepRadius: options.keepRadius ?? DEFAULT_KEEP_RADIUS,
      onLoad: (chunkX, chunkZ, key) => this.rebuild(chunkX, chunkZ, key),
      onUnload: (key) => this.physics.removeChunkCollider(key),
    });
    this.unsubscribePatches = options.terrainPatches?.subscribe((change) => {
      for (const chunk of change.affectedChunks) {
        if (this.residency.has(chunk.key)) this.rebuild(chunk.chunkX, chunk.chunkZ, chunk.key);
      }
      // 所有常驻 trimesh 替换完成后再通知角色系统处理新地面造成的初始穿透。
      options.onTerrainChanged?.(change);
    });
  }

  get residentCount() {
    return this.residency.residentCount;
  }

  ensureAround(x, z) {
    this.residency.ensureAround(x, z);
  }

  sync(focuses) {
    this.residency.sync(focuses);
  }

  rebuild(chunkX, chunkZ, key = toChunkKey(chunkX, chunkZ)) {
    this.physics.setChunkCollider(
      key,
      buildTerrainCollisionMesh(chunkX, chunkZ, this.cellCodeAt),
    );
  }

  clear() {
    this.residency.clear();
  }

  dispose() {
    this.clear();
    this.unsubscribePatches?.();
  }
}
