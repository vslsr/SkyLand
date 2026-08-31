import * as THREE from 'three';
import { createFillMaterial } from '../materials/createFillMaterial';
import { createOutlinedObject } from './outlinedObject';

const GRASS_MATERIAL = createFillMaterial(0xc1d7a6);
const BLADE_GEOMETRY = new THREE.ConeGeometry(0.035, 1, 4, 1, false);

const BLADE_COUNT = 3;
const CLUSTER_RADIUS = 0.09;

/**
 * 一丛草。
 *
 * chunk 里的每一丛都由同一个模板实例化，朝向与缩放的差异由放置算法给出，
 * 所以这里只需要定义「一丛草长什么样」，不再需要手写成片的分布表。
 */
export function createGrassClusterModel(): THREE.Group {
  const cluster = new THREE.Group();

  for (let index = 0; index < BLADE_COUNT; index += 1) {
    const angle = (index / BLADE_COUNT) * Math.PI * 2;
    const height = 0.34 + index * 0.055;
    const blade = createOutlinedObject(BLADE_GEOMETRY, GRASS_MATERIAL);
    blade.position.set(Math.cos(angle) * CLUSTER_RADIUS, height * 0.48, Math.sin(angle) * CLUSTER_RADIUS);
    blade.scale.set(1, height, 1);
    blade.rotation.x = Math.sin(angle) * 0.18;
    blade.rotation.z = Math.cos(angle) * 0.18;
    blade.rotation.y = angle;
    cluster.add(blade);
  }

  return cluster;
}
