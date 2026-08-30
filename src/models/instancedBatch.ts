import * as THREE from 'three';
import { OUTLINE_MATERIAL } from '../materials/lineMaterials';
import { ensureVertexNormals, getOutlineGeometry } from './outlinedObject';
import { markSharedGeometry } from './sharedGeometry';

export interface InstancedSource {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** 每个实例相对所属分组原点的变换。 */
  matrices: THREE.Matrix4[];
  outlineThreshold?: number;
}

export interface BoundingVolume {
  center: THREE.Vector3;
  radius: number;
}

export interface InstancedBatch {
  objects: THREE.Object3D[];
  dispose(): void;
}

/**
 * 用同一批 `BufferAttribute` 造一个新的 `BufferGeometry`，只为换一个包围球。
 *
 * three 的视锥剔除用的是几何自带的包围球，而 `InstancedMesh` 的包围球只覆盖
 * 单个实例，整片草只要原点不在画面里就会被整体剔掉。GPU 缓冲以 attribute 为键，
 * 所以这样换包围球不产生任何额外上传，也不复制顶点数据。
 *
 * 代价是这个视图与别处共用底层数据，绝不能 dispose，因此登记为共用几何。
 */
function createBoundedView(
  source: THREE.BufferGeometry,
  bounds: BoundingVolume,
): THREE.BufferGeometry {
  const view = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(source.attributes)) {
    view.setAttribute(name, attribute);
  }
  if (source.index) view.setIndex(source.index);
  view.boundingSphere = new THREE.Sphere(bounds.center.clone(), bounds.radius);
  return markSharedGeometry(view);
}

/**
 * 把所有实例的轮廓线顶点预先乘上各自的变换，合并成一份几何。
 *
 * three 没有实例化的 `LineSegments`，逐个物体画线正是当前 draw call 的大头；
 * 合并之后无论多少棵树、多少片草，轮廓线都只有一次 draw call。
 */
function mergeOutlines(
  sources: InstancedSource[],
  bounds: BoundingVolume,
): THREE.BufferGeometry | undefined {
  const entries = sources
    .filter((source) => source.matrices.length > 0)
    .map((source) => ({
      positions: getOutlineGeometry(source.geometry, source.outlineThreshold ?? 1).getAttribute(
        'position',
      ),
      matrices: source.matrices,
    }));

  let vertexCount = 0;
  for (const entry of entries) vertexCount += entry.positions.count * entry.matrices.length;
  if (vertexCount === 0) return undefined;

  const merged = new Float32Array(vertexCount * 3);
  const vertex = new THREE.Vector3();
  let offset = 0;

  for (const { positions, matrices } of entries) {
    for (const matrix of matrices) {
      for (let index = 0; index < positions.count; index += 1) {
        vertex
          .set(positions.getX(index), positions.getY(index), positions.getZ(index))
          .applyMatrix4(matrix);
        merged[offset] = vertex.x;
        merged[offset + 1] = vertex.y;
        merged[offset + 2] = vertex.z;
        offset += 3;
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(merged, 3));
  geometry.boundingSphere = new THREE.Sphere(bounds.center.clone(), bounds.radius);
  return geometry;
}

/** 把一批重复物体压成「每种几何一个 InstancedMesh + 一条合并轮廓线」。 */
export function buildInstancedBatch(
  sources: InstancedSource[],
  bounds: BoundingVolume,
  lineMaterial: THREE.LineBasicMaterial = OUTLINE_MATERIAL,
): InstancedBatch {
  const objects: THREE.Object3D[] = [];
  const meshes: THREE.InstancedMesh[] = [];

  for (const source of sources) {
    if (source.matrices.length === 0) continue;
    ensureVertexNormals(source.geometry);

    const mesh = new THREE.InstancedMesh(
      createBoundedView(source.geometry, bounds),
      source.material,
      source.matrices.length,
    );
    source.matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
    mesh.instanceMatrix.needsUpdate = true;
    meshes.push(mesh);
    objects.push(mesh);
  }

  const outline = mergeOutlines(sources, bounds);
  if (outline) objects.push(new THREE.LineSegments(outline, lineMaterial));

  return {
    objects,
    dispose() {
      // InstancedMesh.dispose 只释放 instanceMatrix；几何视图与别处共用属性，不能释放。
      for (const mesh of meshes) mesh.dispose();
      outline?.dispose();
    },
  };
}

export { createBoundedView };
