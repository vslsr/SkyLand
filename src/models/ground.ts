import * as THREE from 'three';
import { CHUNK_SIZE } from '../../shared/world/worldConfig.mjs';
import { createFillMaterial, type FillMaterialEnvironment } from '../materials/createFillMaterial';
import { GROUND_GRID_MATERIAL } from '../materials/lineMaterials';
import { createOutlinedObject } from './outlinedObject';

const GROUND_WIDTH = 34;
const GROUND_DEPTH = 34;
const GROUND_CENTER_Z = -5;

const GRID_SPACING = 2;
const GRID_HEIGHT = 0.012;

function createGroundGrid(): THREE.LineSegments {
  const positions: number[] = [];
  const halfWidth = GROUND_WIDTH / 2;
  const halfDepth = GROUND_DEPTH / 2;

  for (let x = -halfWidth + GRID_SPACING; x < halfWidth; x += GRID_SPACING) {
    positions.push(x, GRID_HEIGHT, -halfDepth, x, GRID_HEIGHT, halfDepth);
  }
  for (let z = -halfDepth + GRID_SPACING; z < halfDepth; z += GRID_SPACING) {
    positions.push(-halfWidth, GRID_HEIGHT, z, halfWidth, GRID_HEIGHT, z);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return new THREE.LineSegments(geometry, GROUND_GRID_MATERIAL);
}

/** 固定尺寸的一整块地面，供不做流式加载的场景使用。 */
export function createGroundModel(
  color: THREE.ColorRepresentation = 0xf1eddf,
  environment?: FillMaterialEnvironment,
): THREE.Group {
  const ground = new THREE.Group();
  ground.position.z = GROUND_CENTER_Z;

  const planeGeometry = new THREE.PlaneGeometry(GROUND_WIDTH, GROUND_DEPTH);
  const plane = createOutlinedObject(planeGeometry, createFillMaterial(color, environment));
  plane.rotation.x = -Math.PI / 2;
  ground.add(plane);
  ground.add(createGroundGrid());
  return ground;
}

/**
 * 单个 chunk 的地面几何体，以 chunk 中心为原点。
 * 地面不描边：每块地都描一圈的话，世界上会浮现出一张 chunk 的网格。
 */
export function createChunkGroundGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

/**
 * chunk 的地面网格线。
 *
 * 每个 chunk 的网格长得一模一样，所以一个流式场景只建一份，由该场景的全部
 * ChunkView 共用，各自靠位置偏移对齐。线只画在起始边、不画结束边，
 * 相邻 chunk 拼起来后间距才是均匀的，接缝上也不会出现双线。
 */
export function createChunkGridGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const half = CHUNK_SIZE / 2;
  for (let offset = -half; offset < half; offset += GRID_SPACING) {
    positions.push(offset, GRID_HEIGHT, -half, offset, GRID_HEIGHT, half);
    positions.push(-half, GRID_HEIGHT, offset, half, GRID_HEIGHT, offset);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}
