import { TERRAIN_CELL_SIZE } from '../world/terrainConfig.mjs';
import { sampleTerrain } from '../world/terrainContent.mjs';
import { terrainMovementHeight } from '../world/terrainMovement.mjs';
import { terrainSampleHasWater } from '../world/terrainWater.mjs';

const QUERY_EPSILON = 1e-6;
const FOOTPRINT_DIRECTIONS = Object.freeze([
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [Math.SQRT1_2, Math.SQRT1_2],
  [Math.SQRT1_2, -Math.SQRT1_2],
  [-Math.SQRT1_2, Math.SQRT1_2],
  [-Math.SQRT1_2, -Math.SQRT1_2],
]);

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** 高度场 provider：查询量只与本次短位移跨过的地形格数量有关。 */
export class TerrainCollisionQuery {
  constructor(options = {}) {
    this.worldSeed = options.worldSeed;
    this.waterLevel = finiteNumber(options.waterLevel);
    this.cellCodeAt = typeof options.cellCodeAt === 'function' ? options.cellCodeAt : undefined;
    this.sampleScratch = {};
    this.neighborScratch = {};
  }

  sampleSupport(x, z, options = {}, target = this.sampleScratch) {
    const sample = sampleTerrain(this.worldSeed, x, z, target, this.cellCodeAt);
    return terrainMovementHeight(sample, this.waterLevel, options.buoyancyDraft);
  }

  groundAt(point, _feetY, _volume, options = {}) {
    const supportY = this.sampleSupport(point.x, point.z, options);
    const minimumY = finiteNumber(options.minimumY, Number.NEGATIVE_INFINITY);
    const maximumY = finiteNumber(options.maximumY, Number.POSITIVE_INFINITY);
    if (supportY < minimumY - QUERY_EPSILON || supportY > maximumY + QUERY_EPSILON) {
      return undefined;
    }
    const buoyantSurface = terrainSampleHasWater(this.sampleScratch, this.waterLevel)
      && Number.isFinite(Number(options.buoyancyDraft))
      && supportY > this.sampleScratch.groundY + QUERY_EPSILON;
    return {
      y: supportY,
      normalX: buoyantSurface ? 0 : this.sampleScratch.normalX,
      normalY: buoyantSurface ? 1 : this.sampleScratch.normalY,
      normalZ: buoyantSurface ? 0 : this.sampleScratch.normalZ,
      walkable: true,
      kind: 'terrain',
    };
  }

  sweepVertical(point, fromY, toY, volume, options = {}) {
    if (toY >= fromY) return undefined;
    const ground = this.groundAt(point, fromY, volume, {
      ...options,
      minimumY: toY,
      maximumY: fromY,
    });
    if (!ground) return undefined;
    const distance = fromY - toY;
    return {
      ...ground,
      t: distance > QUERY_EPSILON ? Math.max(0, Math.min(1, (fromY - ground.y) / distance)) : 0,
      normalY: Math.max(QUERY_EPSILON, ground.normalY),
      kind: 'floor',
    };
  }

  sweepHorizontal(start, end, volume, feetY, options = {}) {
    const radius = Math.max(0, finiteNumber(volume?.radius));
    let earliest;
    for (const direction of FOOTPRINT_DIRECTIONS) {
      const offsetX = direction[0] * radius;
      const offsetZ = direction[1] * radius;
      const hit = this.traceProbe(
        { x: start.x + offsetX, z: start.z + offsetZ },
        { x: end.x + offsetX, z: end.z + offsetZ },
        feetY,
        options,
      );
      if (!hit || (earliest && hit.t >= earliest.t)) continue;
      earliest = hit;
    }
    return earliest;
  }

  traceProbe(start, end, feetY, options) {
    const deltaX = finiteNumber(end.x) - finiteNumber(start.x);
    const deltaZ = finiteNumber(end.z) - finiteNumber(start.z);
    if (deltaX * deltaX + deltaZ * deltaZ <= QUERY_EPSILON * QUERY_EPSILON) return undefined;
    const allowedY = finiteNumber(feetY) + Math.max(0, finiteNumber(options.maximumStepHeight));
    const startSupport = this.sampleSupport(start.x, start.z, options);
    if (startSupport > allowedY + QUERY_EPSILON) {
      return this.initialOverlapHit(start, deltaX, deltaZ, allowedY, options);
    }

    let cellX = Math.floor(start.x / TERRAIN_CELL_SIZE);
    let cellZ = Math.floor(start.z / TERRAIN_CELL_SIZE);
    const endCellX = Math.floor(end.x / TERRAIN_CELL_SIZE);
    const endCellZ = Math.floor(end.z / TERRAIN_CELL_SIZE);
    const stepX = Math.sign(deltaX);
    const stepZ = Math.sign(deltaZ);
    const tDeltaX = stepX === 0 ? Number.POSITIVE_INFINITY : TERRAIN_CELL_SIZE / Math.abs(deltaX);
    const tDeltaZ = stepZ === 0 ? Number.POSITIVE_INFINITY : TERRAIN_CELL_SIZE / Math.abs(deltaZ);
    let tMaxX = stepX === 0
      ? Number.POSITIVE_INFINITY
      : (((stepX > 0 ? cellX + 1 : cellX) * TERRAIN_CELL_SIZE) - start.x) / deltaX;
    let tMaxZ = stepZ === 0
      ? Number.POSITIVE_INFINITY
      : (((stepZ > 0 ? cellZ + 1 : cellZ) * TERRAIN_CELL_SIZE) - start.z) / deltaZ;

    while (cellX !== endCellX || cellZ !== endCellZ) {
      const crossesX = tMaxX <= tMaxZ + QUERY_EPSILON;
      const crossesZ = tMaxZ <= tMaxX + QUERY_EPSILON;
      const t = Math.max(0, Math.min(1, Math.min(tMaxX, tMaxZ)));
      if (crossesX) {
        cellX += stepX;
        tMaxX += tDeltaX;
      }
      if (crossesZ) {
        cellZ += stepZ;
        tMaxZ += tDeltaZ;
      }
      const probeT = Math.min(1, t + QUERY_EPSILON);
      const support = this.sampleSupport(
        start.x + deltaX * probeT,
        start.z + deltaZ * probeT,
        options,
      );
      if (support <= allowedY + QUERY_EPSILON) continue;
      let normalX = crossesX ? -stepX : 0;
      let normalZ = crossesZ ? -stepZ : 0;
      const normalLength = Math.hypot(normalX, normalZ) || 1;
      normalX /= normalLength;
      normalZ /= normalLength;
      return { t, normalX, normalZ, topY: support, kind: 'terrain-wall' };
    }
    return undefined;
  }

  initialOverlapHit(start, deltaX, deltaZ, allowedY, options) {
    const cellX = Math.floor(start.x / TERRAIN_CELL_SIZE);
    const cellZ = Math.floor(start.z / TERRAIN_CELL_SIZE);
    const stepX = Math.sign(deltaX);
    const stepZ = Math.sign(deltaZ);
    let normalX = 0;
    let normalZ = 0;
    if (stepX !== 0) {
      const boundaryX = (stepX > 0 ? cellX : cellX + 1) * TERRAIN_CELL_SIZE;
      const neighbor = this.sampleSupport(boundaryX - stepX * QUERY_EPSILON, start.z, options, this.neighborScratch);
      if (neighbor <= allowedY + QUERY_EPSILON) normalX = -stepX;
    }
    if (stepZ !== 0) {
      const boundaryZ = (stepZ > 0 ? cellZ : cellZ + 1) * TERRAIN_CELL_SIZE;
      const neighbor = this.sampleSupport(start.x, boundaryZ - stepZ * QUERY_EPSILON, options, this.neighborScratch);
      if (neighbor <= allowedY + QUERY_EPSILON) normalZ = -stepZ;
    }
    if (normalX === 0 && normalZ === 0) {
      const length = Math.hypot(deltaX, deltaZ) || 1;
      normalX = -deltaX / length;
      normalZ = -deltaZ / length;
    } else {
      const length = Math.hypot(normalX, normalZ) || 1;
      normalX /= length;
      normalZ /= length;
    }
    return { t: 0, normalX, normalZ, kind: 'terrain-wall' };
  }
}
