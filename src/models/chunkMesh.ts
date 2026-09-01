import * as THREE from 'three';
import type { ChunkGeometryData } from '../../shared/world/chunkGenerator.mjs';
import { createFillMaterial, type FillMaterialEnvironment } from '../materials/createFillMaterial';

/**
 * 一个流式场景全部 chunk 共用的填充材质。
 *
 * 颜色随顶点走，所以地面、树、草、岩石可以共用同一种材质，一个 chunk 的
 * 填充部分因此只占一次 draw call。雾效参数逐场景不同，所以是工厂而不是单例，
 * 由 ChunkStreamer 持有并在场景卸载时释放。
 */
export function createChunkFillMaterial(
  environment: FillMaterialEnvironment,
): THREE.ShaderMaterial {
  return createFillMaterial(0xffffff, environment, { vertexTint: true });
}

/** 台地顶面单独绕过距离雾，避免雾天把玩家脚下的纸面洗成灰白色。 */
export function createChunkGroundFillMaterial(
  environment: FillMaterialEnvironment,
): THREE.ShaderMaterial {
  return createFillMaterial(0xffffff, environment, {
    vertexTint: true,
    fog: false,
  });
}

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
