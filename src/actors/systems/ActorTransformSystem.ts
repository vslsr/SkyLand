import * as THREE from 'three';
import type { ActorWorld } from '../../../shared/actor/ActorWorld.mjs';
import {
  TRANSFORM_COMPONENT,
  type TransformComponent,
} from '../../../shared/actor/components/TransformComponent.mjs';
import {
  THREE_OBJECT_COMPONENT,
  type ThreeObjectComponent,
} from '../components/ThreeObjectComponent';

export class ActorTransformSystem {
  public constructor(private readonly sceneRoot: THREE.Group) {}

  public update(world: ActorWorld, _deltaSeconds: number, _elapsedSeconds: number): void {
    for (const actor of world.query(TRANSFORM_COMPONENT, THREE_OBJECT_COMPONENT)) {
      const transform = actor.requireComponent(TRANSFORM_COMPONENT) as TransformComponent;
      const render = actor.requireComponent(THREE_OBJECT_COMPONENT) as ThreeObjectComponent;
      const parentTransform = actor.parent?.getComponent(TRANSFORM_COMPONENT) as TransformComponent | undefined;
      const parentRender = actor.parent?.getComponent(THREE_OBJECT_COMPONENT) as ThreeObjectComponent | undefined;
      // Actor 根节点只能挂到父 Actor 的权威 root，禁止经过带摇晃/倾斜的 visualRoot。
      const renderParent = parentRender?.root ?? this.sceneRoot;
      if (render.root.parent !== renderParent) renderParent.add(render.root);
      if (parentRender && parentTransform) {
        // 从已插值的父/子世界坐标反算渲染局部坐标，使 Three.js 层级的最终
        // 世界位置严格等于权威插值结果，而不是重新插值 localTransform。
        const deltaX = transform.x - parentTransform.x;
        const deltaZ = transform.z - parentTransform.z;
        const sinYaw = Math.sin(parentTransform.yaw);
        const cosYaw = Math.cos(parentTransform.yaw);
        render.root.position.set(
          cosYaw * deltaX - sinYaw * deltaZ,
          transform.y - parentTransform.y,
          sinYaw * deltaX + cosYaw * deltaZ,
        );
        render.root.rotation.y = normalizeAngle(transform.yaw - parentTransform.yaw);
      } else {
        render.root.position.set(transform.x, transform.y, transform.z);
        render.root.rotation.y = transform.yaw;
      }
    }
  }
}

function normalizeAngle(value: number): number {
  let angle = value;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}
