import { hash32 } from '../../shared/world/hash.mjs';
import { CHUNK_SIZE_MM } from '../../shared/world/worldConfig.mjs';

const POSITION_X_SALT = 0x2f6e2b1d;
const POSITION_Z_SALT = 0x64a9d83b;
const PRESENCE_SALT = 0x18c53a7f;
const PARTICLE_SEED_SALT = 0x73b4e921;
const UINT32_RANGE = 0x1_0000_0000;

export interface InteractiveParticleWorldPoint {
  x: number;
  z: number;
  particleSeed: number;
}

/**
 * 为一个 chunk 生成至多一个客户端表现点。
 *
 * 坐标先在毫米整数域里生成，最后才换算成米；同一 worldSeed、组件 seed 与 chunk
 * 坐标始终得到同一个点。clusterRadius 同时作为 chunk 边缘留白，保证落叶团完整落在
 * 自己所属的 chunk 内，卸载边界不会切掉半个圆。
 */
export function generateInteractiveParticleWorldPoint(
  worldSeed: number,
  componentSeed: number,
  chunkX: number,
  chunkZ: number,
  spawnChance: number,
  clusterRadius: number,
): InteractiveParticleWorldPoint | undefined {
  const combinedSeed = (worldSeed ^ componentSeed) >>> 0;
  const presence = hash32(combinedSeed, chunkX, chunkZ, PRESENCE_SALT) / UINT32_RANGE;
  if (presence >= spawnChance) return undefined;

  const marginMm = Math.ceil(clusterRadius * 1000);
  const availableMm = CHUNK_SIZE_MM - marginMm * 2;
  if (availableMm < 0) return undefined;
  const localXmm = marginMm + (
    hash32(combinedSeed, chunkX, chunkZ, POSITION_X_SALT) % (availableMm + 1)
  );
  const localZmm = marginMm + (
    hash32(combinedSeed, chunkX, chunkZ, POSITION_Z_SALT) % (availableMm + 1)
  );
  return {
    x: (chunkX * CHUNK_SIZE_MM + localXmm) / 1000,
    z: (chunkZ * CHUNK_SIZE_MM + localZmm) / 1000,
    particleSeed: hash32(combinedSeed, chunkX, chunkZ, PARTICLE_SEED_SALT),
  };
}
