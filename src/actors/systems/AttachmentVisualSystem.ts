import * as THREE from 'three';
import type { Actor, ActorWorld } from '../../../shared/actor/index.mjs';
import type { ThreeMeshProxy } from '../../render/three/ThreeMeshProxy';
import type { ThreeRenderScene } from '../../render/three/ThreeRenderScene';
import {
  RENDER_PROXY_COMPONENT,
  type RenderProxyComponent,
} from '../components/RenderProxyComponent';

/**
 * 让子 Actor 的表现层继承父 Actor 的 visualRoot 波动，但不改动任一权威 root。
 * 需放在所有独立视觉动画 System 之后执行。
 */
export class AttachmentVisualSystem {
  private readonly inverseParent = new THREE.Matrix4();
  private readonly inverseChild = new THREE.Matrix4();
  private readonly desiredWorld = new THREE.Matrix4();
  private readonly localVisual = new THREE.Matrix4();

  public constructor(private readonly scene: ThreeRenderScene) {}

  public update(world: ActorWorld, _deltaSeconds: number, _elapsedSeconds: number): void {
    const actors = world.actors() as Actor[];
    for (const actor of actors) {
      const render = this.resolve(actor);
      if (!render) continue;
      render.attachmentVisualRoot.position.set(0, 0, 0);
      render.attachmentVisualRoot.quaternion.identity();
      render.attachmentVisualRoot.scale.set(1, 1, 1);
      render.attachmentVisualRoot.updateMatrix();
    }

    for (const actor of actors) {
      if (!actor.parent) this.updateSubtree(actor);
    }
  }

  private resolve(actor?: Actor): ThreeMeshProxy | undefined {
    const proxy = actor?.getComponent(RENDER_PROXY_COMPONENT) as RenderProxyComponent | undefined;
    return proxy ? this.scene.resolve(proxy.proxyId) : undefined;
  }

  private updateSubtree(actor: Actor): void {
    const render = this.resolve(actor);
    const parentRender = this.resolve(actor.parent as Actor | undefined);
    if (render && parentRender) {
      parentRender.root.updateWorldMatrix(true, false);
      parentRender.visualRoot.updateWorldMatrix(true, false);
      render.root.updateWorldMatrix(true, false);

      // desired = parentVisualWorld * inverse(parentAuthorityWorld) * childAuthorityWorld
      this.inverseParent.copy(parentRender.root.matrixWorld).invert();
      this.desiredWorld.copy(parentRender.visualRoot.matrixWorld)
        .multiply(this.inverseParent)
        .multiply(render.root.matrixWorld);
      this.inverseChild.copy(render.root.matrixWorld).invert();
      this.localVisual.copy(this.inverseChild).multiply(this.desiredWorld);
      this.localVisual.decompose(
        render.attachmentVisualRoot.position,
        render.attachmentVisualRoot.quaternion,
        render.attachmentVisualRoot.scale,
      );
      render.attachmentVisualRoot.updateMatrix();
      render.attachmentVisualRoot.updateWorldMatrix(false, true);
    }
    for (const child of actor.children as Actor[]) this.updateSubtree(child);
  }
}
