import * as THREE from 'three';
import { createFillMaterial } from '../materials/createFillMaterial';
import { createOutlinedObject } from './outlinedObject';
import { markSharedGeometry } from './sharedGeometry';

const GRASS_MATERIAL = createFillMaterial(0xc1d7a6);
const BLADE_GEOMETRY = markSharedGeometry(new THREE.ConeGeometry(0.035, 1, 4, 1, false));

interface GrassPatch {
  position: readonly [number, number];
  bladeCount: number;
  scale: number;
  rotation: number;
}

const GRASS_PATCHES: readonly GrassPatch[] = [
  { position: [-7.2, 1.4], bladeCount: 3, scale: 1.05, rotation: 0.2 },
  { position: [-4.2, 0.3], bladeCount: 2, scale: 0.9, rotation: 1.1 },
  { position: [-2.1, -3.2], bladeCount: 3, scale: 1.15, rotation: 2.2 },
  { position: [1.8, 0.8], bladeCount: 2, scale: 0.82, rotation: 0.5 },
  { position: [4.2, -1.3], bladeCount: 3, scale: 1.2, rotation: 1.8 },
  { position: [7.4, -3.8], bladeCount: 2, scale: 0.96, rotation: 2.7 },
  { position: [-7.8, -6.6], bladeCount: 2, scale: 1.1, rotation: 1.4 },
  { position: [-2.8, -7.5], bladeCount: 3, scale: 0.88, rotation: 0.7 },
  { position: [3.3, -9.2], bladeCount: 2, scale: 1.08, rotation: 2.4 },
  { position: [7.6, -8.0], bladeCount: 3, scale: 0.86, rotation: 0.1 },
  { position: [-9.8, -11.0], bladeCount: 3, scale: 1, rotation: 2 },
  { position: [0.1, -12.5], bladeCount: 2, scale: 1.15, rotation: 0.9 },
  { position: [9.6, -12.0], bladeCount: 3, scale: 0.92, rotation: 1.5 },
];

function createGrassPatch(patch: GrassPatch): THREE.Group {
  const group = new THREE.Group();
  group.position.set(patch.position[0], 0, patch.position[1]);
  group.rotation.y = patch.rotation;

  for (let index = 0; index < patch.bladeCount; index += 1) {
    const angle = (index / patch.bladeCount) * Math.PI * 2 + patch.rotation * 0.35;
    const height = (0.34 + index * 0.055) * patch.scale;
    const blade = createOutlinedObject(BLADE_GEOMETRY, GRASS_MATERIAL);
    blade.position.set(Math.cos(angle) * 0.09, height * 0.48, Math.sin(angle) * 0.09);
    blade.scale.set(1, height, 1);
    blade.rotation.x = Math.sin(angle) * 0.18;
    blade.rotation.z = Math.cos(angle) * 0.18;
    blade.rotation.y = angle;
    group.add(blade);
  }
  return group;
}

export function createGrassField(): THREE.Group {
  const grass = new THREE.Group();
  for (const patch of GRASS_PATCHES) grass.add(createGrassPatch(patch));
  return grass;
}
