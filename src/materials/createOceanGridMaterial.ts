import * as THREE from 'three';
import type { OceanVisualDefinition } from '../scenes/data/SceneDefinition';
import {
  OCEAN_GRID_FRAGMENT_SHADER,
  OCEAN_GRID_VERTEX_SHADER,
} from '../shaders/oceanSurface';
import {
  createEnvironmentUniforms,
  type FillMaterialEnvironment,
} from './createFillMaterial';

export function createOceanGridMaterial(
  definition: OceanVisualDefinition,
  seaLevel: number,
  environment: FillMaterialEnvironment,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: OCEAN_GRID_VERTEX_SHADER,
    fragmentShader: OCEAN_GRID_FRAGMENT_SHADER,
    uniforms: {
      ...createEnvironmentUniforms(environment),
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
    },
    transparent: true,
    depthWrite: false,
  });
}
