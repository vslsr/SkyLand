import * as THREE from 'three';
import { CHUNK_SIZE } from '../../shared/world/worldConfig.mjs';
import { GROUND_GRID_MATERIAL } from '../materials/lineMaterials';

/** 地面的填充色，chunk 合批时作为顶点色写入。 */
export const GROUND_COLOR = 0xf1eddf;

const GRID_SPACING = 2;
const GRID_HEIGHT = 0.012;

/**
 * 单个 chunk 的地面几何体，以 chunk 中心为原点。
 * 地面不描边：每块地都描一圈的话，世界上会浮现出一张 chunk 的网格。
 */
export function createChunkGroundGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

let sharedGridGeometry: THREE.BufferGeometry | undefined;

/**
 * chunk 的地面网格线。
 *
 * 每个 chunk 的网格长得一模一样，所以只建一份几何体，由所有 ChunkView 共用，
 * 各自靠自身的位置偏移对齐。线只画在起始边、不画结束边，
 * 相邻 chunk 拼起来后间距才是均匀的，接缝上也不会出现双线。
 */
export function getChunkGridGeometry(): THREE.BufferGeometry {
  if (sharedGridGeometry) return sharedGridGeometry;

  const positions: number[] = [];
  const half = CHUNK_SIZE / 2;
  for (let offset = -half; offset < half; offset += GRID_SPACING) {
    positions.push(offset, GRID_HEIGHT, -half, offset, GRID_HEIGHT, half);
    positions.push(-half, GRID_HEIGHT, offset, half, GRID_HEIGHT, offset);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  sharedGridGeometry = geometry;
  return geometry;
}

/** chunk 网格线共用的材质。 */
export const CHUNK_GRID_MATERIAL = GROUND_GRID_MATERIAL;
