import * as THREE from 'three';
import type { ActorWorld } from '../../../shared/actor/ActorWorld.mjs';
import {
  BUOYANCY_COMPONENT,
  type BuoyancyComponent,
} from '../../../shared/actor/components/BuoyancyComponent.mjs';
import {
  TRANSFORM_COMPONENT,
  type TransformComponent,
} from '../../../shared/actor/components/TransformComponent.mjs';
import { sampleOceanWaveHeight } from '../../ocean/oceanWaveMath';
import type { OceanVisualDefinition } from '../../scenes/data/SceneDefinition';
import {
  THREE_OBJECT_COMPONENT,
  type ThreeObjectComponent,
} from '../components/ThreeObjectComponent';

/** 只修改视觉子节点；权威 Transform 始终保留服务端快照值。 */
export class WaterBobVisualSystem {
  public constructor(private readonly ocean: OceanVisualDefinition) {}

  public update(world: ActorWorld, deltaSeconds: number, elapsedSeconds: number): void {
    for (const actor of world.query(
      TRANSFORM_COMPONENT,
      BUOYANCY_COMPONENT,
      THREE_OBJECT_COMPONENT,
    )) {
      const transform = actor.requireComponent(TRANSFORM_COMPONENT) as TransformComponent;
      const buoyancy = actor.requireComponent(BUOYANCY_COMPONENT) as BuoyancyComponent;
      const render = actor.requireComponent(THREE_OBJECT_COMPONENT) as ThreeObjectComponent;
      const sinYaw = Math.sin(transform.yaw);
      const cosYaw = Math.cos(transform.yaw);
      const halfLength = render.length * 0.5;
      const halfWidth = render.width * 0.5;
      const sample = (x: number, z: number): number => (
        sampleOceanWaveHeight(x, z, elapsedSeconds, this.ocean)
      );

      const center = sample(transform.x, transform.z);
      const bow = sample(
        transform.x + sinYaw * halfLength,
        transform.z + cosYaw * halfLength,
      );
      const stern = sample(
        transform.x - sinYaw * halfLength,
        transform.z - cosYaw * halfLength,
      );
      const right = sample(
        transform.x + cosYaw * halfWidth,
        transform.z - sinYaw * halfWidth,
      );
      const left = sample(
        transform.x - cosYaw * halfWidth,
        transform.z + sinYaw * halfWidth,
      );
      const targetY = center - buoyancy.draft;
      const targetPitch = THREE.MathUtils.clamp(
        Math.atan2(stern - bow, render.length) + buoyancy.staticPitch,
        -0.07,
        0.07,
      );
      const targetRoll = THREE.MathUtils.clamp(
        Math.atan2(right - left, render.width) + buoyancy.staticRoll,
        -0.09,
        0.09,
      );
      const amount = deltaSeconds > 0 ? 1 - Math.exp(-7 * deltaSeconds) : 1;

      render.visualRoot.position.y = THREE.MathUtils.lerp(
        render.visualRoot.position.y,
        targetY,
        amount,
      );
      render.visualRoot.rotation.x = THREE.MathUtils.lerp(
        render.visualRoot.rotation.x,
        targetPitch,
        amount,
      );
      render.visualRoot.rotation.z = THREE.MathUtils.lerp(
        render.visualRoot.rotation.z,
        targetRoll,
        amount,
      );
    }
  }
}
