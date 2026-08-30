import * as THREE from 'three';
import { createFillMaterial } from '../materials/createFillMaterial';
import { markSharedGeometry } from './sharedGeometry';

export const GRASS_MATERIAL = createFillMaterial(0xc1d7a6);
export const GRASS_BLADE_GEOMETRY = markSharedGeometry(
  new THREE.ConeGeometry(0.035, 1, 4, 1, false),
);

export interface GrassPatchLayout {
  bladeCount: number;
  scale: number;
  rotation: number;
}

const bladePosition = new THREE.Vector3();
const bladeRotation = new THREE.Euler();
const bladeQuaternion = new THREE.Quaternion();
const bladeScale = new THREE.Vector3();

/**
 * 把一处草丛展开成每片草叶相对草丛原点的变换。
 * 叶片沿一圈均匀散开，高度逐片递增，并按角度轻微前后左右倾斜。
 */
export function createGrassBladeMatrices(patch: GrassPatchLayout): THREE.Matrix4[] {
  const matrices: THREE.Matrix4[] = [];

  for (let index = 0; index < patch.bladeCount; index += 1) {
    const angle = (index / patch.bladeCount) * Math.PI * 2 + patch.rotation * 0.35;
    const height = (0.34 + index * 0.055) * patch.scale;

    bladePosition.set(Math.cos(angle) * 0.09, height * 0.48, Math.sin(angle) * 0.09);
    bladeRotation.set(Math.sin(angle) * 0.18, angle, Math.cos(angle) * 0.18);
    bladeQuaternion.setFromEuler(bladeRotation);
    bladeScale.set(1, height, 1);
    matrices.push(new THREE.Matrix4().compose(bladePosition, bladeQuaternion, bladeScale));
  }

  return matrices;
}
