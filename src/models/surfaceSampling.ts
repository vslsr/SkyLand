import * as THREE from 'three';

export interface SurfaceSample {
  readonly point: THREE.Vector3;
  readonly normal: THREE.Vector3;
}

export interface EvenSurfaceSamplingOptions {
  readonly seed?: number;
  /** 返回 false 可排除底面等不应出现视觉效果的三角形。 */
  readonly acceptTriangle?: (
    normal: Readonly<THREE.Vector3>,
    centroid: Readonly<THREE.Vector3>,
  ) => boolean;
}

interface WeightedTriangle {
  readonly a: THREE.Vector3;
  readonly b: THREE.Vector3;
  readonly c: THREE.Vector3;
  readonly normal: THREE.Vector3;
  readonly cumulativeArea: number;
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0 || 0x6d2b79f5;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function readVertex(
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  index: number,
): THREE.Vector3 {
  return new THREE.Vector3(position.getX(index), position.getY(index), position.getZ(index));
}

function collectTriangles(
  geometry: THREE.BufferGeometry,
  acceptTriangle?: EvenSurfaceSamplingOptions['acceptTriangle'],
): WeightedTriangle[] {
  const position = geometry.getAttribute('position');
  if (!position) return [];

  const index = geometry.getIndex();
  const vertexCount = index?.count ?? position.count;
  const triangles: WeightedTriangle[] = [];
  let cumulativeArea = 0;
  for (let offset = 0; offset + 2 < vertexCount; offset += 3) {
    const a = readVertex(position, index?.getX(offset) ?? offset);
    const b = readVertex(position, index?.getX(offset + 1) ?? offset + 1);
    const c = readVertex(position, index?.getX(offset + 2) ?? offset + 2);
    const cross = new THREE.Vector3().subVectors(b, a)
      .cross(new THREE.Vector3().subVectors(c, a));
    const doubledArea = cross.length();
    if (doubledArea <= 1e-8) continue;
    const normal = cross.multiplyScalar(1 / doubledArea);
    const centroid = a.clone().add(b).add(c).multiplyScalar(1 / 3);
    if (acceptTriangle && !acceptTriangle(normal, centroid)) continue;
    cumulativeArea += doubledArea * 0.5;
    triangles.push({ a, b, c, normal, cumulativeArea });
  }
  return triangles;
}

function pickTriangle(
  triangles: readonly WeightedTriangle[],
  targetArea: number,
): WeightedTriangle {
  let low = 0;
  let high = triangles.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) * 0.5);
    if (targetArea <= triangles[middle].cumulativeArea) high = middle;
    else low = middle + 1;
  }
  return triangles[low];
}

function sampleCandidate(
  triangles: readonly WeightedTriangle[],
  random: () => number,
): SurfaceSample {
  const totalArea = triangles[triangles.length - 1].cumulativeArea;
  const triangle = pickTriangle(triangles, random() * totalArea);
  // sqrt 变换让重心坐标在三角形面积内均匀分布。
  const rootU = Math.sqrt(random());
  const v = random();
  const point = triangle.a.clone().multiplyScalar(1 - rootU)
    .addScaledVector(triangle.b, rootU * (1 - v))
    .addScaledVector(triangle.c, rootU * v);
  return { point, normal: triangle.normal.clone() };
}

/**
 * 在 BufferGeometry 表面确定性采样，并用最远点选择降低随机聚团。
 * 候选数固定上限为 2048；用途是模型构建，不进入逐帧更新路径。
 */
export function sampleEvenlyOnSurface(
  geometry: THREE.BufferGeometry,
  count: number,
  options: EvenSurfaceSamplingOptions = {},
): SurfaceSample[] {
  if (!Number.isFinite(count) || count <= 0) return [];
  const sampleCount = Math.min(64, Math.floor(count));
  const triangles = collectTriangles(geometry, options.acceptTriangle);
  if (triangles.length === 0) return [];

  const random = createSeededRandom(options.seed ?? 0x51f15e);
  const candidateCount = Math.min(2048, Math.max(sampleCount, sampleCount * 32));
  const candidates = Array.from(
    { length: candidateCount },
    () => sampleCandidate(triangles, random),
  );

  const selected: SurfaceSample[] = [];
  const used = new Set<number>();
  let nextIndex = Math.floor(random() * candidates.length);
  while (selected.length < sampleCount) {
    selected.push(candidates[nextIndex]);
    used.add(nextIndex);
    if (selected.length === sampleCount) break;

    let bestIndex = -1;
    let bestMinimumDistance = -1;
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      if (used.has(candidateIndex)) continue;
      let minimumDistance = Number.POSITIVE_INFINITY;
      for (const chosen of selected) {
        minimumDistance = Math.min(
          minimumDistance,
          candidates[candidateIndex].point.distanceToSquared(chosen.point),
        );
      }
      if (minimumDistance > bestMinimumDistance) {
        bestMinimumDistance = minimumDistance;
        bestIndex = candidateIndex;
      }
    }
    if (bestIndex < 0) break;
    nextIndex = bestIndex;
  }
  return selected;
}
