import * as THREE from 'three';
import type { Actor, ActorWorld } from '../../../shared/actor/index.mjs';
import {
  THREE_OBJECT_COMPONENT,
  type ThreeObjectComponent,
} from '../components/ThreeObjectComponent';

/**
 * 让子 Actor 的表现层继承父 Actor 的 visualRoot 波动，但不改动任一权威 root。
 * 需放在所有独立视觉动画 System 之后执行。
 */
export class AttachmentVisualSystem {
  private readonly inverseParent = new THREE.Matrix4();
  private readonly inverseChild = new THREE.Matrix4();
  private readonly desiredWorld = new THREE.Matrix4();
  private readonly localVisual = new THREE.Matrix4();

  public update(world: ActorWorld, _deltaSeconds: number, _elapsedSeconds: number): void {
    const actors = world.actors() as Actor[];
    for (const actor of actors) {
      const render = actor.getComponent(THREE_OBJECT_COMPONENT) as ThreeObjectComponent | undefined;
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

  private updateSubtree(actor: Actor): void {
    const render = actor.getComponent(THREE_OBJECT_COMPONENT) as ThreeObjectComponent | undefined;
    const parentRender = actor.parent?.getComponent(THREE_OBJECT_COMPONENT) as ThreeObjectComponent | undefined;
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
