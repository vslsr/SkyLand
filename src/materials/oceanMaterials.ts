import * as THREE from 'three';
import type { OceanVisualDefinition } from '../scenes/data/SceneDefinition';
import type { FillMaterialEnvironment } from './createFillMaterial';
import { createOceanGridMaterial } from './createOceanGridMaterial';
import { createOceanSurfaceMaterial } from './createOceanSurfaceMaterial';

export interface OceanMaterials {
  surface: THREE.ShaderMaterial;
  grid: THREE.ShaderMaterial;
}

export function createOceanMaterials(
  definition: OceanVisualDefinition,
  seaLevel: number,
  environment: FillMaterialEnvironment,
): OceanMaterials {
  return {
    surface: createOceanSurfaceMaterial(definition, seaLevel, environment),
    grid: createOceanGridMaterial(definition, seaLevel, environment),
  };
}
