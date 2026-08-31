import * as THREE from 'three';
import type { FillMaterialEnvironment } from '../materials/createFillMaterial';
import { createBuoyancyRaftModel, type BuoyancyRaftModel } from '../models/ocean/createBuoyancyRaftModel';
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
  private readonly raft?: BuoyancyRaftModel;

  public constructor(options: OceanSystemOptions) {
    this.root.name = 'ocean-system';
    this.definition = options.definition;
    this.seaLevel = options.seaLevel;

    const ocean = createOceanModel(options.definition, options.seaLevel, options.environment);
    this.animatedMaterials = ocean.animatedMaterials;
    this.root.add(ocean.root);

    if (options.definition.demoRaft) {
      this.raft = createBuoyancyRaftModel(options.environment, options.definition.foamColor);
      this.root.add(this.raft.root);
    }
    this.update(0, 0);
  }

  public sampleHeight(x: number, z: number, elapsedSeconds: number): number {
    return this.seaLevel + sampleOceanWaveHeight(x, z, elapsedSeconds, this.definition);
  }

  public update(deltaSeconds: number, elapsedSeconds: number): void {
    for (const material of this.animatedMaterials) {
      material.uniforms.uTime.value = elapsedSeconds;
    }
    if (this.raft) this.updateRaft(this.raft, deltaSeconds, elapsedSeconds);
  }

  private updateRaft(
    raft: BuoyancyRaftModel,
    deltaSeconds: number,
    elapsedSeconds: number,
  ): void {
    const x = raft.root.position.x;
    const z = raft.root.position.z;
    const yaw = raft.root.rotation.y;
    const sinYaw = Math.sin(yaw);
    const cosYaw = Math.cos(yaw);
    const halfLength = raft.length * 0.5;
    const halfWidth = raft.width * 0.5;

    const center = this.sampleHeight(x, z, elapsedSeconds);
    const bow = this.sampleHeight(x + sinYaw * halfLength, z + cosYaw * halfLength, elapsedSeconds);
    const stern = this.sampleHeight(x - sinYaw * halfLength, z - cosYaw * halfLength, elapsedSeconds);
    const right = this.sampleHeight(x + cosYaw * halfWidth, z - sinYaw * halfWidth, elapsedSeconds);
    const left = this.sampleHeight(x - cosYaw * halfWidth, z + sinYaw * halfWidth, elapsedSeconds);

    const targetY = center - raft.visualDraft;
    const targetPitch = THREE.MathUtils.clamp(
      Math.atan2(stern - bow, raft.length) + raft.trimPitch,
      -0.07,
      0.07,
    );
    const targetRoll = THREE.MathUtils.clamp(
      Math.atan2(right - left, raft.width) + raft.trimRoll,
      -0.09,
      0.09,
    );
    const amount = deltaSeconds > 0 ? 1 - Math.exp(-7 * deltaSeconds) : 1;

    raft.visualRoot.position.y = THREE.MathUtils.lerp(raft.visualRoot.position.y, targetY, amount);
    raft.visualRoot.rotation.x = THREE.MathUtils.lerp(raft.visualRoot.rotation.x, targetPitch, amount);
    raft.visualRoot.rotation.z = THREE.MathUtils.lerp(raft.visualRoot.rotation.z, targetRoll, amount);
  }
}
