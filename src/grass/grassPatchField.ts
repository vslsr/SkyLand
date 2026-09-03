import { hash32 } from '../../shared/world/hash.mjs';
import { CHUNK_SIZE_MM } from '../../shared/world/worldConfig.mjs';

const PRESENCE_SALT = 0x1b8f37a5;
const CENTER_X_SALT = 0x5cd1f2b7;
const CENTER_Z_SALT = 0x2a76be13;
const RADIUS_SALT = 0x74e2c05f;
const VERTEX_SALT = 0x3f19ad6b;
const BLADE_SEED_SALT = 0x6ce8b41d;
const UINT32_RANGE = 0x1_0000_0000;

/** 一丛草的轮廓采样点数；凸包之后留下的顶点是它的子集。 */
const OUTLINE_SAMPLE_COUNT = 11;
/** 采样半径的最小占比，越小轮廓越不规则。 */
const MIN_RADIUS_RATIO = 0.58;

export interface GrassPatchConfig {
  /** 每个 chunk 至多生成几丛。 */
  readonly maxPerChunk: number;
  /** 每一丛独立出现的概率，[0, 1]。 */
  readonly spawnChance: number;
  /** 外接半径的下限与上限（米）。 */
  readonly minRadius: number;
  readonly maxRadius: number;
  /** 每平方米铺多少片叶子。 */
  readonly bladeDensity: number;
}

export const DEFAULT_GRASS_PATCH_CONFIG: GrassPatchConfig = {
  maxPerChunk: 3,
  spawnChance: 0.55,
  minRadius: 2.4,
  maxRadius: 5.2,
  bladeDensity: 20,
};

export interface GrassPatch {
  readonly centerX: number;
  readonly centerZ: number;
  /** 外接半径：轮廓上的点都不会超出它，用来算包围盒与 chunk 留白。 */
  readonly radius: number;
  /** 凸多边形顶点，按逆时针摊平成 `[x0, z0, x1, z1, ...]`。 */
  readonly vertices: readonly number[];
  /** 这一丛撒叶片用的种子。 */
  readonly bladeSeed: number;
}

/**
 * 为一个 chunk 生成确定性的草丛轮廓。
 *
 * 与落叶团一样，坐标先在毫米整数域里定下来，同一 worldSeed 与 chunk 坐标
 * 永远得到同一批草丛；中心留出外接半径的边距，因此每一丛都完整落在自己的
 * chunk 内，卸载边界不会切掉半丛草。数量的上界是 `maxPerChunk`，与世界面积无关。
 */
export function generateChunkGrassPatches(
  worldSeed: number,
  chunkX: number,
  chunkZ: number,
  config: GrassPatchConfig = DEFAULT_GRASS_PATCH_CONFIG,
): GrassPatch[] {
  const patches: GrassPatch[] = [];
  const maximumRadiusMm = Math.ceil(config.maxRadius * 1000);
  const availableMm = CHUNK_SIZE_MM - maximumRadiusMm * 2;
  if (availableMm <= 0 || config.maxPerChunk <= 0 || config.spawnChance <= 0) return patches;

  const minimumRadiusMm = Math.min(
    maximumRadiusMm,
    Math.max(1, Math.ceil(config.minRadius * 1000)),
  );
  for (let index = 0; index < config.maxPerChunk; index += 1) {
    const slot = (index + 1) * 0x9e37;
    const presence = hash32(worldSeed, chunkX, chunkZ, PRESENCE_SALT ^ slot) / UINT32_RANGE;
    if (presence >= config.spawnChance) continue;

    const radiusMm = minimumRadiusMm + (
      hash32(worldSeed, chunkX, chunkZ, RADIUS_SALT ^ slot)
      % (maximumRadiusMm - minimumRadiusMm + 1)
    );
    const centerXmm = maximumRadiusMm + (
      hash32(worldSeed, chunkX, chunkZ, CENTER_X_SALT ^ slot) % (availableMm + 1)
    );
    const centerZmm = maximumRadiusMm + (
      hash32(worldSeed, chunkX, chunkZ, CENTER_Z_SALT ^ slot) % (availableMm + 1)
    );
    const centerX = (chunkX * CHUNK_SIZE_MM + centerXmm) / 1000;
    const centerZ = (chunkZ * CHUNK_SIZE_MM + centerZmm) / 1000;
    const radius = radiusMm / 1000;

    patches.push({
      centerX,
      centerZ,
      radius,
      vertices: createPatchOutline(worldSeed, chunkX, chunkZ, slot, centerX, centerZ, radius),
      bladeSeed: hash32(worldSeed, chunkX, chunkZ, BLADE_SEED_SALT ^ slot),
    });
  }
  return patches;
}

/**
 * 绕中心取一圈半径不等的采样点，再取它们的凸包。
 *
 * 直接连采样点会得到星形的凹多边形，凸包把凹进去的点丢掉，剩下的顶点数
 * 与形状都随种子变化——大小不一、边数不等的不规则凸多边形。
 */
function createPatchOutline(
  worldSeed: number,
  chunkX: number,
  chunkZ: number,
  slot: number,
  centerX: number,
  centerZ: number,
  radius: number,
): number[] {
  const points: number[] = [];
  for (let index = 0; index < OUTLINE_SAMPLE_COUNT; index += 1) {
    const angleNoise = hash32(worldSeed, chunkX, chunkZ, VERTEX_SALT ^ slot ^ (index * 0x2545));
    const radiusNoise = hash32(worldSeed, chunkX, chunkZ, VERTEX_SALT ^ slot ^ (index * 0x85eb));
    const angle = (index + (angleNoise / UINT32_RANGE) * 0.85) / OUTLINE_SAMPLE_COUNT
      * Math.PI * 2;
    const sampleRadius = radius * (
      MIN_RADIUS_RATIO + (radiusNoise / UINT32_RANGE) * (1 - MIN_RADIUS_RATIO)
    );
    points.push(
      centerX + Math.cos(angle) * sampleRadius,
      centerZ + Math.sin(angle) * sampleRadius,
    );
  }
  return ensureCounterClockwise(convexHull(points));
}

/**
 * 统一成逆时针顺序。
 *
 * 内外判定只做一次叉积符号比较，前提是顶点绕向固定；凸包的绕向取决于
 * 输入顺序，所以在这里一次性归一，而不是让每个调用方各自判断。
 */
function ensureCounterClockwise(vertices: readonly number[]): number[] {
  if (signedPolygonArea(vertices) >= 0) return [...vertices];
  const reversed: number[] = [];
  for (let index = vertices.length / 2 - 1; index >= 0; index -= 1) {
    reversed.push(vertices[index * 2], vertices[index * 2 + 1]);
  }
  return reversed;
}

/** Andrew monotone chain：输入摊平的 `[x, z, ...]`，返回逆时针的凸包顶点。 */
export function convexHull(points: readonly number[]): number[] {
  const count = points.length / 2;
  if (count < 3) return [...points];
  const order = Array.from({ length: count }, (_unused, index) => index).sort((a, b) => (
    points[a * 2] - points[b * 2] || points[a * 2 + 1] - points[b * 2 + 1]
  ));

  const build = (indices: readonly number[]): number[] => {
    const chain: number[] = [];
    for (const index of indices) {
      while (chain.length >= 2) {
        const last = chain[chain.length - 1];
        const previous = chain[chain.length - 2];
        if (cross(points, previous, last, index) > 0) break;
        chain.pop();
      }
      chain.push(index);
    }
    chain.pop();
    return chain;
  };

  const hull = [...build(order), ...build([...order].reverse())];
  const vertices: number[] = [];
  for (const index of hull) vertices.push(points[index * 2], points[index * 2 + 1]);
  return vertices;
}

function cross(points: readonly number[], a: number, b: number, c: number): number {
  return (points[b * 2] - points[a * 2]) * (points[c * 2 + 1] - points[a * 2 + 1])
    - (points[b * 2 + 1] - points[a * 2 + 1]) * (points[c * 2] - points[a * 2]);
}

/** 多边形面积（鞋带公式），与绕向无关。 */
export function polygonArea(vertices: readonly number[]): number {
  return Math.abs(signedPolygonArea(vertices));
}

function signedPolygonArea(vertices: readonly number[]): number {
  let twiceArea = 0;
  const count = vertices.length / 2;
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    twiceArea += vertices[index * 2] * vertices[next * 2 + 1]
      - vertices[next * 2] * vertices[index * 2 + 1];
  }
  return twiceArea * 0.5;
}

/** 点是否落在逆时针凸多边形内。 */
export function isInsideConvexPolygon(
  vertices: readonly number[],
  x: number,
  z: number,
): boolean {
  const count = vertices.length / 2;
  if (count < 3) return false;
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    const edgeX = vertices[next * 2] - vertices[index * 2];
    const edgeZ = vertices[next * 2 + 1] - vertices[index * 2 + 1];
    const toPointX = x - vertices[index * 2];
    const toPointZ = z - vertices[index * 2 + 1];
    if (edgeX * toPointZ - edgeZ * toPointX < 0) return false;
  }
  return true;
}
