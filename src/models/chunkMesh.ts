import * as THREE from 'three';
import type { ChunkGeometryData } from '../../shared/world/chunkGenerator.mjs';
import { createFillMaterial } from '../materials/createFillMaterial';
import { OUTLINE_MATERIAL } from '../materials/lineMaterials';

/**
 * 全部 chunk 共用的填充材质。
 *
 * 颜色随顶点走，所以地面、树、草、岩石可以共用同一种材质，
 * 一个 chunk 的填充部分因此只占一次 draw call。材质是模块级单例，
 * ChunkView 卸载时只释放几何体，不要释放它。
 */
export const CHUNK_FILL_MATERIAL = createFillMaterial(0xffffff, { vertexTint: true });

/** chunk 轮廓线共用的材质，与其它线稿模型保持同一支笔。 */
export const CHUNK_OUTLINE_MATERIAL = OUTLINE_MATERIAL;

/**
 * 合批后的填充几何体。
 *
 * 顶点已经是世界坐标，所以承载它的 Mesh 保持在原点即可，
 * 自动算出的包围球也就直接落在正确的位置上，视锥剔除按 chunk 生效。
 */
export function createChunkFillGeometry(data: ChunkGeometryData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.fillPositions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.fillNormals, 3));
  geometry.setAttribute('tint', new THREE.BufferAttribute(data.fillTints, 3));
  return geometry;
}

/** 合批后的轮廓线几何体。 */
export function createChunkOutlineGeometry(data: ChunkGeometryData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.linePositions, 3));
  return geometry;
}
