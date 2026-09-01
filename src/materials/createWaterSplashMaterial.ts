import * as THREE from 'three';
import type { OceanVisualDefinition } from '../scenes/data/SceneDefinition';
import {
  WATER_SPLASH_FRAGMENT_SHADER,
  WATER_SPLASH_VERTEX_SHADER,
} from '../shaders/waterSplash';

/** 岸边水花完全在顶点着色器中循环，所有 chunk 共用一个材质和一个时间。 */
export function createWaterSplashMaterial(
  definition: OceanVisualDefinition,
  seaLevel: number,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: WATER_SPLASH_VERTEX_SHADER,
    fragmentShader: WATER_SPLASH_FRAGMENT_SHADER,
    uniforms: {
      uTime: { value: 0 },
      uSeaLevel: { value: seaLevel },
      uColor: { value: new THREE.Color(definition.gridLineColor).lerp(
        new THREE.Color(definition.surfaceColor),
        0.55,
      ) },
    },
    transparent: true,
    depthWrite: false,
  });
}
