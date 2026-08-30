import * as THREE from 'three';
import { BufferGeometryUtils } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createFillMaterial } from '../materials/createFillMaterial';
import { markSharedGeometry } from './sharedGeometry';

export const TRUNK_MATERIAL = createFillMaterial(0xd6bea3);
export const NEEDLE_MATERIAL = createFillMaterial(0xcbdcbc);

interface CrownLayer {
  radius: number;
  height: number;
  y: number;
  rotation: number;
}

const CROWN_LAYERS: readonly CrownLayer[] = [
  { radius: 1.35, height: 1.7, y: 1.45, rotation: 0.08 },
  { radius: 1.05, height: 1.55, y: 2.15, rotation: -0.13 },
  { radius: 0.75, height: 1.4, y: 2.8, rotation: 0.17 },
  { radius: 0.45, height: 1.2, y: 3.38, rotation: -0.04 },
];

/** 一棵树的顶端高度，用于估算地块包围球。 */
export const TREE_HEIGHT = 3.98;

function createCrownGeometry(): THREE.BufferGeometry {
  // 四层树冠的相对位置在每棵树上都一样，直接烘焙进几何，
  // 这样整片树林的树冠只需要一个 InstancedMesh。
  const layers = CROWN_LAYERS.map((layer) => {
    const geometry = new THREE.ConeGeometry(layer.radius, layer.height, 7, 1, false);
    geometry.rotateY(layer.rotation);
    geometry.translate(0, layer.y, 0);
    return geometry;
  });

  const merged = BufferGeometryUtils.mergeBufferGeometries(layers);
  if (!merged) throw new Error('树冠几何合并失败');
  for (const layer of layers) layer.dispose();
  return merged;
}

export const TREE_TRUNK_GEOMETRY = markSharedGeometry(
  new THREE.CylinderGeometry(0.1, 0.17, 1.3, 7, 1, false).translate(0, 0.65, 0),
);

export const TREE_CROWN_GEOMETRY = markSharedGeometry(createCrownGeometry());
