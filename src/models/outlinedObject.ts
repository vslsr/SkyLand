import * as THREE from 'three';
import { OUTLINE_MATERIAL } from '../materials/lineMaterials';

export function createOutlinedObject(
  geometry: THREE.BufferGeometry,
  fillMaterial: THREE.Material,
  thresholdAngle = 1,
  lineMaterial: THREE.LineBasicMaterial = OUTLINE_MATERIAL,
): THREE.Group {
  geometry.computeVertexNormals();

  const object = new THREE.Group();
  object.add(new THREE.Mesh(geometry, fillMaterial));
  object.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry, thresholdAngle), lineMaterial));
  return object;
}
