import * as THREE from 'three';
import {
  CHUNK_BOUNDING_RADIUS,
  CHUNK_HALF_SIZE,
  chunkCenter,
} from '../../shared/chunkCoordinates.mjs';
import {
  GRASS_BLADE_GEOMETRY,
  GRASS_MATERIAL,
  createGrassBladeMatrices,
} from '../models/grass';
import {
  GROUND_GRID_GEOMETRY,
  GROUND_GRID_MATERIAL,
  GROUND_MATERIAL,
  GROUND_PLANE_GEOMETRY,
} from '../models/ground';
import { buildInstancedBatch, type InstancedSource } from '../models/instancedBatch';
import {
  NEEDLE_MATERIAL,
  TREE_CROWN_GEOMETRY,
  TREE_HEIGHT,
  TREE_TRUNK_GEOMETRY,
  TRUNK_MATERIAL,
} from '../models/tree';
import { createChunkContent, type GrassPatch, type TreePlacement } from './worldGen';

export interface Chunk {
  readonly x: number;
  readonly z: number;
  readonly group: THREE.Group;
  /** 世界空间包围盒，供整块剔除。 */
  readonly box: THREE.Box3;
  dispose(): void;
}

// 树冠可能探出地块边界，包围盒往外放一点，避免边缘物体被提前剔掉。
const CHUNK_OVERHANG = 2.5;
const CHUNK_CEILING = 6;

const workPosition = new THREE.Vector3();
const workRotation = new THREE.Euler();
const workQuaternion = new THREE.Quaternion();
const workScale = new THREE.Vector3();
const patchMatrix = new THREE.Matrix4();

function composeMatrix(x: number, z: number, rotationY: number, uniformScale: number): THREE.Matrix4 {
  workPosition.set(x, 0, z);
  workRotation.set(0, rotationY, 0);
  workQuaternion.setFromEuler(workRotation);
  workScale.setScalar(uniformScale);
  return new THREE.Matrix4().compose(workPosition, workQuaternion, workScale);
}

function createTreeMatrices(trees: readonly TreePlacement[]): THREE.Matrix4[] {
  return trees.map((tree) => composeMatrix(tree.x, tree.z, tree.rotation, tree.scale));
}

function createGrassMatrices(patches: readonly GrassPatch[]): THREE.Matrix4[] {
  const matrices: THREE.Matrix4[] = [];

  for (const patch of patches) {
    workPosition.set(patch.x, 0, patch.z);
    workRotation.set(0, patch.rotation, 0);
    workQuaternion.setFromEuler(workRotation);
    workScale.setScalar(1);
    patchMatrix.compose(workPosition, workQuaternion, workScale);

    for (const blade of createGrassBladeMatrices(patch)) {
      matrices.push(new THREE.Matrix4().multiplyMatrices(patchMatrix, blade));
    }
  }

  return matrices;
}

/**
 * 构建一个地块。
 *
 * 地块内所有重复物体压成实例化网格，轮廓线合并成一条，
 * 于是不管地块里有多少棵树多少片草，draw call 都是固定的。
 */
export function buildChunk(chunkX: number, chunkZ: number): Chunk {
  const content = createChunkContent(chunkX, chunkZ);
  const center = chunkCenter(chunkX, chunkZ);

  const group = new THREE.Group();
  group.name = `chunk-${chunkX}-${chunkZ}`;
  group.position.set(center.x, 0, center.z);

  // 地面与网格线不是实例化的，几何自带的包围球随物体变换即可，无需另建视图。
  group.add(new THREE.Mesh(GROUND_PLANE_GEOMETRY, GROUND_MATERIAL));
  group.add(new THREE.LineSegments(GROUND_GRID_GEOMETRY, GROUND_GRID_MATERIAL));

  const treeMatrices = createTreeMatrices(content.trees);
  const sources: InstancedSource[] = [
    { geometry: TREE_TRUNK_GEOMETRY, material: TRUNK_MATERIAL, matrices: treeMatrices },
    { geometry: TREE_CROWN_GEOMETRY, material: NEEDLE_MATERIAL, matrices: treeMatrices },
    {
      geometry: GRASS_BLADE_GEOMETRY,
      material: GRASS_MATERIAL,
      matrices: createGrassMatrices(content.grassPatches),
    },
  ];

  const batch = buildInstancedBatch(sources, {
    center: new THREE.Vector3(0, TREE_HEIGHT / 2, 0),
    radius: CHUNK_BOUNDING_RADIUS,
  });
  for (const object of batch.objects) group.add(object);

  // 地块整体做包围盒剔除，子物体不必再各自判定：地块内容又宽又扁，
  // 外接球半径至少 22.6 米，球与球大面积交叠，几乎剔不掉任何东西。
  for (const child of group.children) child.frustumCulled = false;

  const box = new THREE.Box3(
    new THREE.Vector3(
      center.x - CHUNK_HALF_SIZE - CHUNK_OVERHANG,
      0,
      center.z - CHUNK_HALF_SIZE - CHUNK_OVERHANG,
    ),
    new THREE.Vector3(
      center.x + CHUNK_HALF_SIZE + CHUNK_OVERHANG,
      CHUNK_CEILING,
      center.z + CHUNK_HALF_SIZE + CHUNK_OVERHANG,
    ),
  );

  return {
    x: chunkX,
    z: chunkZ,
    group,
    box,
    dispose() {
      batch.dispose();
      group.parent?.remove(group);
      group.clear();
    },
  };
}
