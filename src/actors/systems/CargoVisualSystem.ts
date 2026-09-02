import * as THREE from 'three';
import type { ActorWorld } from '../../../shared/actor/ActorWorld.mjs';
import {
  CARGO_COMPONENT,
} from '../../../shared/actor/components/CargoComponent.mjs';
import {
  TRANSFORM_COMPONENT,
  type TransformComponent,
} from '../../../shared/actor/components/TransformComponent.mjs';
import { sampleOceanWaveHeight } from '../../ocean/oceanWaveMath';
import type { OceanVisualDefinition } from '../../scenes/data/SceneDefinition';
import {
  RENDER_PROXY_COMPONENT,
  type RenderProxyComponent,
} from '../components/RenderProxyComponent';
import type { ThreeRenderScene } from '../../render/three/ThreeRenderScene';

/** 自由货箱漂在客户端波面；装载后的父级波动由 AttachmentVisualSystem 叠加。 */
export class CargoVisualSystem {
  public constructor(
    private readonly scene: ThreeRenderScene,
    private readonly ocean: OceanVisualDefinition,
  ) {}

  public update(world: ActorWorld, deltaSeconds: number, elapsedSeconds: number): void {
    for (const actor of world.query(
      TRANSFORM_COMPONENT,
      CARGO_COMPONENT,
      RENDER_PROXY_COMPONENT,
    )) {
      const transform = actor.requireComponent(TRANSFORM_COMPONENT) as TransformComponent;
      const proxy = actor.requireComponent(RENDER_PROXY_COMPONENT) as RenderProxyComponent;
      const render = this.scene.resolve(proxy.proxyId);
      if (!render) continue;
      let targetY = actor.parent ? 0 : sampleOceanWaveHeight(
          transform.x,
          transform.z,
          elapsedSeconds,
          this.ocean,
        ) - 0.14;
      let targetPitch = 0;
      let targetRoll = 0;
      const amount = deltaSeconds > 0 ? 1 - Math.exp(-8 * deltaSeconds) : 1;
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
