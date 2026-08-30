import * as THREE from 'three';
import { CHUNK_HALF_SIZE, CHUNK_SIZE } from '../../shared/chunkCoordinates.mjs';
import { createFillMaterial } from '../materials/createFillMaterial';
import { GROUND_GRID_MATERIAL } from '../materials/lineMaterials';
import { markSharedGeometry } from './sharedGeometry';

const GRID_SPACING = 2;

export const GROUND_MATERIAL = createFillMaterial(0xf1eddf);

export const GROUND_PLANE_GEOMETRY = markSharedGeometry(
  new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE).rotateX(-Math.PI / 2),
);

function createGridGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];

  // 起点含左/下边界、终点不含右/上边界，相邻地块的网格线因此首尾相接，
  // 拼起来看不出接缝。地面本身不再描边——无限世界没有边界可画。
  for (let offset = -CHUNK_HALF_SIZE; offset < CHUNK_HALF_SIZE; offset += GRID_SPACING) {
    positions.push(offset, 0.012, -CHUNK_HALF_SIZE, offset, 0.012, CHUNK_HALF_SIZE);
    positions.push(-CHUNK_HALF_SIZE, 0.012, offset, CHUNK_HALF_SIZE, 0.012, offset);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

export const GROUND_GRID_GEOMETRY = markSharedGeometry(createGridGeometry());

export { GROUND_GRID_MATERIAL };
