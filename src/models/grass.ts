import * as THREE from 'three';
import { createOutlinedObject } from './outlinedObject';

const BLADE_VERTEX_COUNT = 7;
const BLADE_INDEX_COUNT = 15;
const DEFAULT_BLADES_PER_SQUARE_UNIT = 28;
const MIN_BLADE_COUNT = 8_000;
const MAX_BLADE_COUNT = 32_000;

export interface GrassFieldBounds {
  minimumX: number;
  maximumX: number;
  minimumZ: number;
  maximumZ: number;
}

export interface GrassFieldGeometryOptions {
  bounds: GrassFieldBounds;
  bladeCount?: number;
  seed?: number;
}

/** 一条来自 chunk 生成器的既有草簇放置记录。 */
export interface GrassClusterPlacement {
  x: number;
  z: number;
  rotation: number;
  scale: number;
}

export interface GrassFieldGeometry {
  fill: THREE.InstancedBufferGeometry;
  outline: THREE.InstancedBufferGeometry;
  instanceCount: number;
}

interface InstanceAttributeArrays {
  offsets: Float32Array;
  scales: Float32Array;
  rotations: Float32Array;
  phases: Float32Array;
  tones: Float32Array;
}

/**
 * Seven vertices form a five-triangle tapered blade. Keeping the source blade
 * tiny lets the field spend its geometry budget on instances instead of meshes.
 */
export function createGrassBladeGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.18, 0, 0,
    0.18, 0, 0,
    -0.5, 0.3, 0,
    0.5, 0.3, 0,
    -0.28, 0.7, 0,
    0.28, 0.7, 0,
    0, 1, 0,
  ], 3));
  geometry.setIndex([
    0, 1, 2,
    1, 3, 2,
    2, 3, 4,
    3, 5, 4,
    4, 5, 6,
  ]);
  geometry.computeVertexNormals();
  return geometry;
}

export function createGrassFieldGeometry(options: GrassFieldGeometryOptions): GrassFieldGeometry {
  const instanceCount = options.bladeCount ?? calculateBladeCount(options.bounds);
  const blade = createGrassBladeGeometry();
  const edges = new THREE.EdgesGeometry(blade, 20);
  const attributes = createInstanceAttributeArrays(options.bounds, instanceCount, options.seed ?? 0x51a9);
  const fill = createInstancedGeometry(blade, attributes, instanceCount);
  const outline = createInstancedGeometry(edges, attributes, instanceCount);

  blade.dispose();
  edges.dispose();

  return { fill, outline, instanceCount };
}

function calculateBladeCount(bounds: GrassFieldBounds): number {
  const area = (bounds.maximumX - bounds.minimumX) * (bounds.maximumZ - bounds.minimumZ);
  return THREE.MathUtils.clamp(
    Math.round(area * DEFAULT_BLADES_PER_SQUARE_UNIT),
    MIN_BLADE_COUNT,
    MAX_BLADE_COUNT,
  );
}

function createInstanceAttributeArrays(
  bounds: GrassFieldBounds,
  count: number,
  seed: number,
): InstanceAttributeArrays {
  const random = createSeededRandom(seed);
  const offsets = new Float32Array(count * 3);
  const scales = new Float32Array(count * 2);
  const rotations = new Float32Array(count);
  const phases = new Float32Array(count);
  const tones = new Float32Array(count);
  const width = bounds.maximumX - bounds.minimumX;
  const depth = bounds.maximumZ - bounds.minimumZ;
  const columns = Math.max(1, Math.ceil(Math.sqrt(count * width / depth)));
  const rows = Math.ceil(count / columns);
  const cellWidth = width / columns;
  const cellDepth = depth / rows;

  for (let index = 0; index < count; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = bounds.minimumX + (column + 0.12 + random() * 0.76) * cellWidth;
    const z = bounds.minimumZ + (row + 0.12 + random() * 0.76) * cellDepth;
    const height = 0.34 + Math.pow(random(), 0.7) * 0.38;
    const bladeWidth = (0.045 + random() * 0.035) * (0.82 + height * 0.28);

    offsets[index * 3] = x;
    offsets[index * 3 + 1] = 0.018;
    offsets[index * 3 + 2] = z;
    scales[index * 2] = bladeWidth;
    scales[index * 2 + 1] = height;
    rotations[index] = random() * Math.PI * 2;
    phases[index] = random() * Math.PI * 2;
    tones[index] = random() * 2 - 1;
  }

  return { offsets, scales, rotations, phases, tones };
}

function createInstancedGeometry(
  source: THREE.BufferGeometry,
  attributes: InstanceAttributeArrays,
  instanceCount: number,
): THREE.InstancedBufferGeometry {
  const geometry = new THREE.InstancedBufferGeometry();
  if (source.index) geometry.setIndex(source.index.clone());
  for (const [name, attribute] of Object.entries(source.attributes)) {
    geometry.setAttribute(name, attribute.clone());
  }

  geometry.setAttribute(
    'aOffset',
    new THREE.InstancedBufferAttribute(attributes.offsets.slice(), 3),
  );
  geometry.setAttribute(
    'aScale',
    new THREE.InstancedBufferAttribute(attributes.scales.slice(), 2),
  );
  geometry.setAttribute(
    'aRotation',
    new THREE.InstancedBufferAttribute(attributes.rotations.slice(), 1),
  );
  geometry.setAttribute(
    'aPhase',
    new THREE.InstancedBufferAttribute(attributes.phases.slice(), 1),
  );
  geometry.setAttribute(
    'aTone',
    new THREE.InstancedBufferAttribute(attributes.tones.slice(), 1),
  );
  geometry.instanceCount = instanceCount;
  return geometry;
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

export const GRASS_BLADE_GEOMETRY_STATS = {
  vertexCount: BLADE_VERTEX_COUNT,
  indexCount: BLADE_INDEX_COUNT,
} as const;

const CLUSTER_BLADE_COUNT = 3;
const CLUSTER_RADIUS = 0.09;
const CLUSTER_BLADE_WIDTH = 0.3;

/**
 * 把流式世界里已有的草簇记录转换成可弯曲的实例草。
 *
 * 每条记录仍然只生成原模板里的三片叶子；簇中心、旋转与缩放直接沿用
 * 整数世界生成器解码出的值，因此替换不会改变分布或把草地铺密。
 */
export function createPlacedGrassGeometry(
  placements: readonly GrassClusterPlacement[],
): GrassFieldGeometry {
  const instanceCount = placements.length * CLUSTER_BLADE_COUNT;
  const attributes: InstanceAttributeArrays = {
    offsets: new Float32Array(instanceCount * 3),
    scales: new Float32Array(instanceCount * 2),
    rotations: new Float32Array(instanceCount),
    phases: new Float32Array(instanceCount),
    tones: new Float32Array(instanceCount),
  };

  let instanceIndex = 0;
  for (const placement of placements) {
    const sine = Math.sin(placement.rotation);
    const cosine = Math.cos(placement.rotation);

    for (let bladeIndex = 0; bladeIndex < CLUSTER_BLADE_COUNT; bladeIndex += 1) {
      const angle = (bladeIndex / CLUSTER_BLADE_COUNT) * Math.PI * 2;
      const localX = Math.cos(angle) * CLUSTER_RADIUS * placement.scale;
      const localZ = Math.sin(angle) * CLUSTER_RADIUS * placement.scale;
      const height = (0.34 + bladeIndex * 0.055) * placement.scale;
      const offsetIndex = instanceIndex * 3;
      const scaleIndex = instanceIndex * 2;

      // 与 chunkGenerator.emitTemplate 的 Y 轴旋转约定完全一致。
      attributes.offsets[offsetIndex] = placement.x + cosine * localX + sine * localZ;
      attributes.offsets[offsetIndex + 1] = 0.018;
      attributes.offsets[offsetIndex + 2] = placement.z + cosine * localZ - sine * localX;
      attributes.scales[scaleIndex] = CLUSTER_BLADE_WIDTH * placement.scale;
      attributes.scales[scaleIndex + 1] = height;
      attributes.rotations[instanceIndex] = placement.rotation + angle;
      attributes.phases[instanceIndex] =
        hashGrassInstance(placement, bladeIndex, 0x51a9) * Math.PI * 2;
      attributes.tones[instanceIndex] =
        hashGrassInstance(placement, bladeIndex, 0x7f4a) * 2 - 1;
      instanceIndex += 1;
    }
  }

  const blade = createGrassBladeGeometry();
  const edges = new THREE.EdgesGeometry(blade, 20);
  const fill = createInstancedGeometry(blade, attributes, instanceCount);
  const outline = createInstancedGeometry(edges, attributes, instanceCount);
  blade.dispose();
  edges.dispose();
  return { fill, outline, instanceCount };
}

function hashGrassInstance(
  placement: GrassClusterPlacement,
  bladeIndex: number,
  salt: number,
): number {
  let hash = Math.imul(Math.round(placement.x * 1000), 73_856_093)
    ^ Math.imul(Math.round(placement.z * 1000), 19_349_663)
    ^ Math.imul(bladeIndex + 1, 83_492_791)
    ^ salt;
  hash = Math.imul(hash ^ hash >>> 16, 0x45d9f3b);
  hash = Math.imul(hash ^ hash >>> 16, 0x45d9f3b);
  return ((hash ^ hash >>> 16) >>> 0) / 4_294_967_296;
}

/**
 * 一丛草，供 chunk 流式生成使用。
 *
 * 与 GrassFieldSystem 是两条路：那一套按整块活动区一次性铺满并支持踩踏交互，
 * 适合固定尺寸的场景；流式世界里草随 chunk 进出，每一丛都由这个模板实例化，
 * 朝向与缩放的差异由放置算法给出，所以这里只定义「一丛草长什么样」。
 * 叶片形状取自同一个 createGrassBladeGeometry，两条路的观感保持一致。
 */
export function createGrassClusterModel(material: THREE.Material): THREE.Group {
  const cluster = new THREE.Group();
  const blade = createGrassBladeGeometry();

  for (let index = 0; index < CLUSTER_BLADE_COUNT; index += 1) {
    const angle = (index / CLUSTER_BLADE_COUNT) * Math.PI * 2;
    const height = 0.34 + index * 0.055;
    const leaf = createOutlinedObject(blade, material);
    leaf.position.set(
      Math.cos(angle) * CLUSTER_RADIUS,
      0,
      Math.sin(angle) * CLUSTER_RADIUS,
    );
    leaf.scale.set(CLUSTER_BLADE_WIDTH, height, CLUSTER_BLADE_WIDTH);
    leaf.rotation.x = Math.sin(angle) * 0.18;
    leaf.rotation.z = Math.cos(angle) * 0.18;
    leaf.rotation.y = angle;
    cluster.add(leaf);
  }

  return cluster;
}
