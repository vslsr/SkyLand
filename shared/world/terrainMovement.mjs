import { terrainSampleHasWater } from './terrainWater.mjs';

/** 水面提供浮力支撑，但河床高于浮力位置时仍以河床为准。 */
export function terrainMovementHeight(sample, waterLevel = 0, buoyancyDraft) {
  return terrainSampleHasWater(sample, waterLevel) && Number.isFinite(buoyancyDraft)
    ? Math.max(sample.groundY, waterLevel - Math.max(0, buoyancyDraft))
    : sample.groundY;
}
