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
  public update(world: ActorWorld, _deltaSeconds: number, _elapsedSeconds: number): void {
    for (const actor of world.query(TRANSFORM_COMPONENT, THREE_OBJECT_COMPONENT)) {
      const transform = actor.requireComponent(TRANSFORM_COMPONENT) as TransformComponent;
      const render = actor.requireComponent(THREE_OBJECT_COMPONENT) as ThreeObjectComponent;
      render.root.position.set(transform.x, transform.y, transform.z);
      render.root.rotation.y = transform.yaw;
    }
  }
}
