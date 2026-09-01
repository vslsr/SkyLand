import * as THREE from 'three';
import type { OceanVisualDefinition } from '../scenes/data/SceneDefinition';
import {
  OCEAN_SURFACE_FRAGMENT_SHADER,
  OCEAN_SURFACE_VERTEX_SHADER,
} from '../shaders/oceanSurface';
import type { FillMaterialEnvironment } from './createFillMaterial';

export function createOceanSurfaceMaterial(
  definition: OceanVisualDefinition,
  seaLevel: number,
  environment: FillMaterialEnvironment,
): THREE.ShaderMaterial {
  const runtime = environment.runtime;
  return new THREE.ShaderMaterial({
    vertexShader: OCEAN_SURFACE_VERTEX_SHADER,
    fragmentShader: OCEAN_SURFACE_FRAGMENT_SHADER,
    uniforms: {
      uTime: { value: 0 },
      uSeaLevel: { value: seaLevel },
      uWaveHeight: { value: definition.waveHeight },
      uWaveSpeed: { value: definition.waveSpeed },
      uNoiseScale: { value: definition.noiseScale },
      uNoiseStrength: { value: definition.noiseStrength },
      uGridStep: { value: definition.size / definition.segments },
      uInterlaceStrength: { value: definition.interlaceStrength },
      uFogColor: runtime?.fogColor ?? { value: new THREE.Color(environment.fogColor) },
      uFogNear: runtime?.fogNear ?? { value: environment.fogNear },
      uFogFar: runtime?.fogFar ?? { value: environment.fogFar },
      uAmbientColor: runtime?.ambientColor ?? { value: new THREE.Color(0xffffff) },
      uDaylight: runtime?.daylight ?? { value: 1 },
      uSunDirection: runtime?.sunDirection ?? {
        value: new THREE.Vector3(-0.55, 0.9, 0.35).normalize(),
      },
    },
    vertexColors: true,
    side: THREE.DoubleSide,
  });
}
