import type { GrassPatch } from '../grass/grassPatchField';
import { isInsideConvexPolygon, polygonArea } from '../grass/grassPatchField';
import {
  buildGrassFieldGeometry,
  createGrassInstanceArrays,
  createSeededRandom,
  GRASS_BLADE_GROUND_OFFSET,
  writeGrassBladeInstance,
  type GrassFieldGeometry,
} from './grass';

/** 撒点的尝试次数上限，按目标叶片数放大；轮廓越窄被拒的点越多。 */
const SAMPLE_ATTEMPT_RATIO = 3;

export interface GrassPatchGeometryOptions {
  /** 每平方米的叶片数。 */
  bladeDensity: number;
  /**
   * 采样一个位置的草根高度；返回 undefined 表示这里不长草（水面、洞口）。
   * 由调用方决定采样口径，几何这一层不认识地形。
   */
  sampleAnchor: (x: number, z: number) => number | undefined;
  /** 一个 chunk 的叶片总量上限，防止极端配置把显存吃满。 */
  maximumBladeCount: number;
}

/**
 * 把一批草丛轮廓铺成密草。
 *
 * 叶片只在凸多边形内部落点，因此草丛边界是轮廓本身而不是包围盒；相邻的
 * 草丛（同一 chunk 内或跨 chunk 相接）在视觉上就连成一片。叶片数按面积算，
 * 又被 `maximumBladeCount` 截断，所以单个 chunk 的实例数有硬上界。
 */
export function createGrassPatchGeometry(
  patches: readonly GrassPatch[],
  options: GrassPatchGeometryOptions,
): GrassFieldGeometry | undefined {
  if (patches.length === 0) return undefined;
  const budget = Math.max(0, Math.floor(options.maximumBladeCount));
  if (budget === 0) return undefined;

  const arrays = createGrassInstanceArrays(budget);
  let instanceCount = 0;

  for (const patch of patches) {
    if (instanceCount >= budget) break;
    const target = Math.min(
      Math.round(polygonArea(patch.vertices) * options.bladeDensity),
      budget - instanceCount,
    );
    if (target <= 0) continue;

    const random = createSeededRandom(patch.bladeSeed);
    const minimumX = patch.centerX - patch.radius;
    const minimumZ = patch.centerZ - patch.radius;
    const span = patch.radius * 2;
    let placed = 0;
    let attempts = 0;
    const attemptLimit = target * SAMPLE_ATTEMPT_RATIO;

    while (placed < target && attempts < attemptLimit) {
      attempts += 1;
      const x = minimumX + random() * span;
      const z = minimumZ + random() * span;
      if (!isInsideConvexPolygon(patch.vertices, x, z)) continue;
      const anchorY = options.sampleAnchor(x, z);
      if (anchorY === undefined) continue;
      writeGrassBladeInstance(
        arrays,
        instanceCount,
        x,
        anchorY + GRASS_BLADE_GROUND_OFFSET,
        z,
        random,
      );
      instanceCount += 1;
      placed += 1;
    }
  }

  if (instanceCount === 0) return undefined;
  return buildGrassFieldGeometry(trimGrassInstanceArrays(arrays, instanceCount), instanceCount);
}

/**
 * 按实际写入的实例数裁掉尾部空位。
 *
 * 预算是按面积估的上界，被水面或轮廓拒掉的点会留下空洞；不裁的话这些
 * 零值实例会在世界原点堆出一撮草。
 */
function trimGrassInstanceArrays(
  arrays: ReturnType<typeof createGrassInstanceArrays>,
  count: number,
): ReturnType<typeof createGrassInstanceArrays> {
  return {
    offsets: arrays.offsets.subarray(0, count * 3),
    scales: arrays.scales.subarray(0, count * 2),
    rotations: arrays.rotations.subarray(0, count),
    phases: arrays.phases.subarray(0, count),
    tones: arrays.tones.subarray(0, count),
  };
}
