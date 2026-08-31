import * as THREE from 'three';
import type { OceanVisualDefinition } from '../scenes/data/SceneDefinition';
import {
  OCEAN_GRID_FRAGMENT_SHADER,
  OCEAN_GRID_VERTEX_SHADER,
} from '../shaders/oceanSurface';
import type { FillMaterialEnvironment } from './createFillMaterial';

export function createOceanGridMaterial(
  definition: OceanVisualDefinition,
  seaLevel: number,
  environment: FillMaterialEnvironment,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: OCEAN_GRID_VERTEX_SHADER,
    fragmentShader: OCEAN_GRID_FRAGMENT_SHADER,
    uniforms: {
      uTime: { value: 0 },
      uSeaLevel: { value: seaLevel },
      uWaveHeight: { value: definition.waveHeight },
      uWaveSpeed: { value: definition.waveSpeed },
      uNoiseScale: { value: definition.noiseScale },
      uNoiseStrength: { value: definition.noiseStrength },
      uGridStep: { value: definition.size / definition.segments },
      uInterlaceStrength: { value: definition.interlaceStrength },
      uLineColor: { value: new THREE.Color(definition.gridLineColor) },
      uOpacity: { value: definition.gridLineOpacity },
      uFogColor: { value: new THREE.Color(environment.fogColor) },
      uFogNear: { value: environment.fogNear },
      uFogFar: { value: environment.fogFar },
    },
    transparent: true,
    depthWrite: false,
  });
}
