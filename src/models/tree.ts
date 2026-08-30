import * as THREE from 'three';
import { createFillMaterial } from '../materials/createFillMaterial';
import { createOutlinedObject } from './outlinedObject';
import { markSharedGeometry } from './sharedGeometry';

const TRUNK_MATERIAL = createFillMaterial(0xd6bea3);
const NEEDLE_MATERIAL = createFillMaterial(0xcbdcbc);

interface CrownLayer {
  geometry: THREE.ConeGeometry;
  y: number;
  rotation: number;
}

// 每棵树的形状都一样，几何只建一份共用，位置与旋转留在 Object3D 上。
const TRUNK_GEOMETRY = markSharedGeometry(new THREE.CylinderGeometry(0.1, 0.17, 1.3, 7, 1, false));

const CROWN_LAYERS: readonly CrownLayer[] = [
  { geometry: new THREE.ConeGeometry(1.35, 1.7, 7, 1, false), y: 1.45, rotation: 0.08 },
  { geometry: new THREE.ConeGeometry(1.05, 1.55, 7, 1, false), y: 2.15, rotation: -0.13 },
  { geometry: new THREE.ConeGeometry(0.75, 1.4, 7, 1, false), y: 2.8, rotation: 0.17 },
  { geometry: new THREE.ConeGeometry(0.45, 1.2, 7, 1, false), y: 3.38, rotation: -0.04 },
].map((layer) => ({ ...layer, geometry: markSharedGeometry(layer.geometry) }));

interface TreePlacement {
  position: readonly [number, number, number];
  rotation: number;
  scale: number;
}

const TREE_PLACEMENTS: readonly TreePlacement[] = [
  { position: [-5.2, 0, -3.8], rotation: 0.14, scale: 1.05 },
  { position: [0.5, 0, -8.2], rotation: -0.22, scale: 1.34 },
  { position: [5.1, 0, -4.8], rotation: 0.3, scale: 0.92 },
];

function createCrownLayer(layer: CrownLayer): THREE.Group {
  const crown = createOutlinedObject(layer.geometry, NEEDLE_MATERIAL);
  crown.position.y = layer.y;
  crown.rotation.y = layer.rotation;
  return crown;
}

export function createTreeModel(): THREE.Group {
  const tree = new THREE.Group();
  const trunk = createOutlinedObject(TRUNK_GEOMETRY, TRUNK_MATERIAL);
  trunk.position.y = 0.65;
  tree.add(trunk);

  for (const layer of CROWN_LAYERS) tree.add(createCrownLayer(layer));
  return tree;
}

export function createTreeField(): THREE.Group {
  const trees = new THREE.Group();
  for (const placement of TREE_PLACEMENTS) {
    const tree = createTreeModel();
    tree.position.set(...placement.position);
    tree.rotation.y = placement.rotation;
    tree.scale.setScalar(placement.scale);
    trees.add(tree);
  }
  return trees;
}
