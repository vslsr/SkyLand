/**
 * 玩家与小型 Actor 共用的地形移动约束。
 *
 * 地形是规则稠密数据，不登记成每格一个碰撞盒。每次输入只沿本次短位移采样，
 * 步数封顶，因此成本不随世界面积和已走过距离增长。
 */

import {
  TERRAIN_CELL_SIZE,
  TERRAIN_HEIGHT_STEP,
  TERRAIN_SHAPE,
} from './terrainConfig.mjs';
import { sampleTerrain } from './terrainContent.mjs';
import { terrainSampleHasWater } from './terrainWater.mjs';

const MAXIMUM_TERRAIN_STEPS = 64;
const STEP_LENGTH = TERRAIN_CELL_SIZE * 0.2;
const HEIGHT_EPSILON = 1e-5;
const scratchPrevious = Array.from({ length: 5 }, () => ({}));
const scratchNext = Array.from({ length: 5 }, () => ({}));

function sampleFootprint(worldSeed, point, radius, targets, cellCodeAt) {
  const footprintRadius = Math.max(0, Number(radius) || 0);
  sampleTerrain(worldSeed, point.x, point.z, targets[0], cellCodeAt);
  sampleTerrain(worldSeed, point.x + footprintRadius, point.z, targets[1], cellCodeAt);
  sampleTerrain(worldSeed, point.x - footprintRadius, point.z, targets[2], cellCodeAt);
  sampleTerrain(worldSeed, point.x, point.z + footprintRadius, targets[3], cellCodeAt);
  sampleTerrain(worldSeed, point.x, point.z - footprintRadius, targets[4], cellCodeAt);
}

/** 水面提供浮力支撑，但河床高于浮力位置时仍以河床为准。 */
export function terrainMovementHeight(sample, waterLevel = 0, buoyancyDraft) {
  return terrainSampleHasWater(sample, waterLevel) && Number.isFinite(buoyancyDraft)
    ? Math.max(sample.groundY, waterLevel - Math.max(0, buoyancyDraft))
    : sample.groundY;
}

function footprintStepAllowed(
  previous,
  next,
  horizontalDistance,
  maximumStepHeight,
  waterLevel,
  buoyancyDraft,
  moverMinimumY,
) {
  const maximumSlope = TERRAIN_HEIGHT_STEP / TERRAIN_CELL_SIZE;
  const continuousRise = horizontalDistance * maximumSlope;
  for (let index = 0; index < next.length; index += 1) {
    const before = previous[index];
    const after = next[index];
    // 下落不受 maximumStepHeight 限制；只有向上跨越才需要判断角色能迈多高。
    const beforeHeight = terrainMovementHeight(before, waterLevel, buoyancyDraft);
    const afterHeight = terrainMovementHeight(after, waterLevel, buoyancyDraft);
    const heightRise = afterHeight - beforeHeight;
    const includesRamp = before.shape !== TERRAIN_SHAPE.FLAT
      || after.shape !== TERRAIN_SHAPE.FLAT;
    const allowedRise = maximumStepHeight + (includesRamp ? continuousRise : 0);
    if (heightRise <= allowedRise + HEIGHT_EPSILON) continue;

    // 角色跳上台面后，碰撞圆的后缘可能仍跨在低处水格里。此时后缘继续向岸内
    // 移动会再次采到“水→陆”的高度差，但角色脚底其实已经在岸面之上，不应被
    // 二次挡住。绝对脚底高度只作为局部台阶判定的补充；脚还在水面下时仍会阻挡。
    const clearsFromMoverHeight = Number.isFinite(moverMinimumY)
      && afterHeight <= moverMinimumY + allowedRise + HEIGHT_EPSILON;
    if (!clearsFromMoverHeight) return false;
  }
  return true;
}

function traceTerrain(
  worldSeed,
  from,
  to,
  radius,
  maximumStepHeight,
  waterLevel,
  buoyancyDraft,
  moverMinimumY,
  cellCodeAt,
) {
  const deltaX = to.x - from.x;
  const deltaZ = to.z - from.z;
  const distance = Math.hypot(deltaX, deltaZ);
  const steps = Math.max(1, Math.min(MAXIMUM_TERRAIN_STEPS, Math.ceil(distance / STEP_LENGTH)));
  let previousX = from.x;
  let previousZ = from.z;
  sampleFootprint(worldSeed, from, radius, scratchPrevious, cellCodeAt);

  for (let step = 1; step <= steps; step += 1) {
    const amount = step / steps;
    const next = { x: from.x + deltaX * amount, z: from.z + deltaZ * amount };
    sampleFootprint(worldSeed, next, radius, scratchNext, cellCodeAt);
    const stepDistance = Math.hypot(next.x - previousX, next.z - previousZ);
    if (!footprintStepAllowed(
      scratchPrevious,
      scratchNext,
      stepDistance,
      maximumStepHeight,
      waterLevel,
      buoyancyDraft,
      moverMinimumY,
    )) {
      return undefined;
    }
    for (let index = 0; index < scratchPrevious.length; index += 1) {
      const swap = scratchPrevious[index];
      scratchPrevious[index] = scratchNext[index];
      scratchNext[index] = swap;
    }
    previousX = next.x;
    previousZ = next.z;
  }

  return {
    x: to.x,
    y: terrainMovementHeight(scratchPrevious[0], waterLevel, buoyancyDraft),
    z: to.z,
  };
}

/**
 * 先尝试完整位移，失败时分别尝试 X/Z，得到贴着悬崖和岸线滑动的手感。
 */
export function resolveTerrainMovement(
  worldSeed,
  from,
  to,
  options = {},
) {
  const radius = Math.max(0, Number(options.radius) || 0);
  const maximumStepHeight = Math.max(0, Number(options.maximumStepHeight) || 0);
  const waterLevel = Number.isFinite(Number(options.waterLevel)) ? Number(options.waterLevel) : 0;
  const rawBuoyancyDraft = Number(options.buoyancyDraft);
  const buoyancyDraft = Number.isFinite(rawBuoyancyDraft)
    ? Math.max(0, rawBuoyancyDraft)
    : undefined;
  const rawMinimumY = Number(options.minimumY);
  const minimumY = Number.isFinite(rawMinimumY) ? rawMinimumY : undefined;
  const cellCodeAt = typeof options.cellCodeAt === 'function'
    ? options.cellCodeAt
    : undefined;
  const direct = traceTerrain(
    worldSeed,
    from,
    to,
    radius,
    maximumStepHeight,
    waterLevel,
    buoyancyDraft,
    minimumY,
    cellCodeAt,
  );
  if (direct) return direct;

  const alongX = traceTerrain(
    worldSeed,
    from,
    { x: to.x, z: from.z },
    radius,
    maximumStepHeight,
    waterLevel,
    buoyancyDraft,
    minimumY,
    cellCodeAt,
  );
  if (alongX) {
    const alongZ = traceTerrain(
      worldSeed,
      alongX,
      { x: alongX.x, z: to.z },
      radius,
      maximumStepHeight,
      waterLevel,
      buoyancyDraft,
      minimumY,
      cellCodeAt,
    );
    return alongZ ?? alongX;
  }

  const alongZ = traceTerrain(
    worldSeed,
    from,
    { x: from.x, z: to.z },
    radius,
    maximumStepHeight,
    waterLevel,
    buoyancyDraft,
    minimumY,
    cellCodeAt,
  );
  if (alongZ) return alongZ;

  const current = sampleTerrain(worldSeed, from.x, from.z, {}, cellCodeAt);
  return {
    x: from.x,
    y: terrainMovementHeight(current, waterLevel, buoyancyDraft),
    z: from.z,
  };
}
