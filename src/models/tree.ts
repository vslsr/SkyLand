import * as THREE from 'three';
import { createFillMaterial } from '../materials/createFillMaterial';
import { createOutlinedObject } from './outlinedObject';

const TRUNK_MATERIAL = createFillMaterial(0xd6bea3);
const NEEDLE_MATERIAL = createFillMaterial(0xcbdcbc);

function createCrownLayer(radius: number, height: number, y: number, rotation: number): THREE.Group {
  const geometry = new THREE.ConeGeometry(radius, height, 7, 1, false);
  const layer = createOutlinedObject(geometry, NEEDLE_MATERIAL);
  layer.position.y = y;
  layer.rotation.y = rotation;
  return layer;
}

export function createTreeModel(): THREE.Group {
  const tree = new THREE.Group();
  const trunkGeometry = new THREE.CylinderGeometry(0.1, 0.17, 1.3, 7, 1, false);
  const trunk = createOutlinedObject(trunkGeometry, TRUNK_MATERIAL);
  trunk.position.y = 0.65;
  tree.add(trunk);

  tree.add(createCrownLayer(1.35, 1.7, 1.45, 0.08));
  tree.add(createCrownLayer(1.05, 1.55, 2.15, -0.13));
  tree.add(createCrownLayer(0.75, 1.4, 2.8, 0.17));
  tree.add(createCrownLayer(0.45, 1.2, 3.38, -0.04));
  return tree;
}
