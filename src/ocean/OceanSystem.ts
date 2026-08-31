import * as THREE from 'three';
import type { FillMaterialEnvironment } from '../materials/createFillMaterial';
import { createOceanModel } from '../models/ocean/createOceanModel';
import type { SceneVisualSystem } from '../scene/SceneVisualSystem';
import type { OceanVisualDefinition } from '../scenes/data/SceneDefinition';
import { sampleOceanWaveHeight } from './oceanWaveMath';

export interface OceanSystemOptions {
  definition: OceanVisualDefinition;
  seaLevel: number;
  environment: FillMaterialEnvironment;
}

export class OceanSystem implements SceneVisualSystem {
  public readonly root = new THREE.Group();
  private readonly definition: OceanVisualDefinition;
  private readonly seaLevel: number;
  private readonly animatedMaterials: readonly THREE.ShaderMaterial[];

  public constructor(options: OceanSystemOptions) {
    this.root.name = 'ocean-system';
    this.definition = options.definition;
    this.seaLevel = options.seaLevel;

    const ocean = createOceanModel(options.definition, options.seaLevel, options.environment);
    this.animatedMaterials = ocean.animatedMaterials;
    this.root.add(ocean.root);
    this.update(0, 0);
  }

  public sampleHeight(x: number, z: number, elapsedSeconds: number): number {
    return this.seaLevel + sampleOceanWaveHeight(x, z, elapsedSeconds, this.definition);
  }

  public update(_deltaSeconds: number, elapsedSeconds: number): void {
    for (const material of this.animatedMaterials) {
      material.uniforms.uTime.value = elapsedSeconds;
    }
  }
}
