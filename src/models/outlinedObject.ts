import * as THREE from 'three';
import { OUTLINE_MATERIAL } from '../materials/lineMaterials';
import { markSharedGeometry } from './sharedGeometry';

// 顶点法线与轮廓线都只取决于几何本身，和物体的变换无关。
// 同一份几何被大量物体复用时（草叶、树冠层），这两项纯 CPU 计算
// 只做一次就够，结果按几何缓存下来共用。
const normalizedGeometries = new WeakSet<THREE.BufferGeometry>();
const edgesByGeometry = new WeakMap<THREE.BufferGeometry, Map<number, THREE.BufferGeometry>>();

function ensureVertexNormals(geometry: THREE.BufferGeometry): void {
  if (normalizedGeometries.has(geometry)) return;
  geometry.computeVertexNormals();
  normalizedGeometries.add(geometry);
}

function getOutlineGeometry(
  geometry: THREE.BufferGeometry,
  thresholdAngle: number,
): THREE.BufferGeometry {
  let byThreshold = edgesByGeometry.get(geometry);
  if (!byThreshold) {
    byThreshold = new Map();
    edgesByGeometry.set(geometry, byThreshold);
  }

  const cached = byThreshold.get(thresholdAngle);
  if (cached) return cached;

  const created = markSharedGeometry(new THREE.EdgesGeometry(geometry, thresholdAngle));
  byThreshold.set(thresholdAngle, created);
  return created;
}

export function createOutlinedObject(
  geometry: THREE.BufferGeometry,
  fillMaterial: THREE.Material,
  thresholdAngle = 1,
  lineMaterial: THREE.LineBasicMaterial = OUTLINE_MATERIAL,
): THREE.Group {
  ensureVertexNormals(geometry);

  const object = new THREE.Group();
  object.add(new THREE.Mesh(geometry, fillMaterial));
  object.add(new THREE.LineSegments(getOutlineGeometry(geometry, thresholdAngle), lineMaterial));
  return object;
}
