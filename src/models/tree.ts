import * as THREE from 'three';
import { createFillMaterial, type FillMaterialEnvironment } from '../materials/createFillMaterial';
import { createOutlinedObject } from './outlinedObject';

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

function createCrownLayer(
  radius: number,
  height: number,
  y: number,
  rotation: number,
  material: THREE.Material,
): THREE.Group {
  const geometry = new THREE.ConeGeometry(radius, height, 7, 1, false);
  const layer = createOutlinedObject(geometry, material);
  layer.position.y = y;
  layer.rotation.y = rotation;
  return layer;
}

export function createTreeModel(
  trunkMaterial: THREE.Material = createFillMaterial(0xd6bea3),
  needleMaterial: THREE.Material = createFillMaterial(0xcbdcbc),
): THREE.Group {
  const tree = new THREE.Group();
  const trunkGeometry = new THREE.CylinderGeometry(0.1, 0.17, 1.3, 7, 1, false);
  const trunk = createOutlinedObject(trunkGeometry, trunkMaterial);
  trunk.position.y = 0.65;
  tree.add(trunk);

  tree.add(createCrownLayer(1.35, 1.7, 1.45, 0.08, needleMaterial));
  tree.add(createCrownLayer(1.05, 1.55, 2.15, -0.13, needleMaterial));
  tree.add(createCrownLayer(0.75, 1.4, 2.8, 0.17, needleMaterial));
  tree.add(createCrownLayer(0.45, 1.2, 3.38, -0.04, needleMaterial));
  return tree;
}

export function createTreeField(
  colors: { trunk: THREE.ColorRepresentation; needles: THREE.ColorRepresentation } = {
    trunk: 0xd6bea3,
    needles: 0xcbdcbc,
  },
  environment?: FillMaterialEnvironment,
): THREE.Group {
  const trees = new THREE.Group();
  const trunkMaterial = createFillMaterial(colors.trunk, environment);
  const needleMaterial = createFillMaterial(colors.needles, environment);
  for (const placement of TREE_PLACEMENTS) {
    const tree = createTreeModel(trunkMaterial, needleMaterial);
    tree.position.set(...placement.position);
    tree.rotation.y = placement.rotation;
    tree.scale.setScalar(placement.scale);
    trees.add(tree);
  }
  return trees;
}
