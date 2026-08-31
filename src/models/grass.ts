import * as THREE from 'three';
import { createFillMaterial, type FillMaterialEnvironment } from '../materials/createFillMaterial';
import { createOutlinedObject } from './outlinedObject';

const BLADE_GEOMETRY = new THREE.ConeGeometry(0.035, 1, 4, 1, false);

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

function createGrassPatch(patch: GrassPatch, material: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  group.position.set(patch.position[0], 0, patch.position[1]);
  group.rotation.y = patch.rotation;

  for (let index = 0; index < patch.bladeCount; index += 1) {
    const angle = (index / patch.bladeCount) * Math.PI * 2 + patch.rotation * 0.35;
    const height = (0.34 + index * 0.055) * patch.scale;
    const blade = createOutlinedObject(BLADE_GEOMETRY, material);
    blade.position.set(Math.cos(angle) * 0.09, height * 0.48, Math.sin(angle) * 0.09);
    blade.scale.set(1, height, 1);
    blade.rotation.x = Math.sin(angle) * 0.18;
    blade.rotation.z = Math.cos(angle) * 0.18;
    blade.rotation.y = angle;
    group.add(blade);
  }
  return group;
}

export function createGrassField(
  color: THREE.ColorRepresentation = 0xc1d7a6,
  environment?: FillMaterialEnvironment,
): THREE.Group {
  const grass = new THREE.Group();
  const material = createFillMaterial(color, environment);
  for (const patch of GRASS_PATCHES) grass.add(createGrassPatch(patch, material));
  return grass;
}

const CLUSTER_BLADE_COUNT = 3;
const CLUSTER_RADIUS = 0.09;

/**
 * 一丛草，供 chunk 流式生成使用。
 *
 * 流式场景里每一丛都由同一个模板实例化，朝向与缩放的差异由放置算法给出，
 * 所以这里只定义「一丛草长什么样」，不需要手写成片的分布表。
 */
export function createGrassClusterModel(material: THREE.Material): THREE.Group {
  const cluster = new THREE.Group();

  for (let index = 0; index < CLUSTER_BLADE_COUNT; index += 1) {
    const angle = (index / CLUSTER_BLADE_COUNT) * Math.PI * 2;
    const height = 0.34 + index * 0.055;
    const blade = createOutlinedObject(BLADE_GEOMETRY, material);
    blade.position.set(
      Math.cos(angle) * CLUSTER_RADIUS,
      height * 0.48,
      Math.sin(angle) * CLUSTER_RADIUS,
    );
    blade.scale.set(1, height, 1);
    blade.rotation.x = Math.sin(angle) * 0.18;
    blade.rotation.z = Math.cos(angle) * 0.18;
    blade.rotation.y = angle;
    cluster.add(blade);
  }

  return cluster;
}
