import { COLLISION_LAYER } from '../collision/collisionLayers.mjs';

/** Translate existing Actor/simple-collision authoring into PhysicsWorld's flat contract. */
export function simpleCollisionInstanceToPhysicsDefinition(instance) {
  if (!instance) return undefined;
  const collision = instance.collision;
  const transform = instance.transform;
  return {
    shape: collision.shape,
    centerX: collision.centerX,
    centerZ: collision.centerZ,
    halfWidth: collision.halfWidth,
    halfLength: collision.halfLength,
    minimumY: collision.minimumY,
    maximumY: collision.maximumY,
    x: transform.x,
    y: transform.y,
    z: transform.z,
    yaw: transform.yaw,
    layers: instance.layers ?? COLLISION_LAYER.MOVEMENT,
  };
}

/** 菌盖等 authoring 支撑面会额外生成一枚薄 collider，而不是退化成细根顶面。 */
export function simpleCollisionInstanceToPhysicsDefinitions(instance) {
  const body = simpleCollisionInstanceToPhysicsDefinition(instance);
  if (!body) return [];
  const collision = instance.collision;
  if (!collision.supportShape) return [body];
  const capThickness = Math.min(
    0.16,
    Math.max(0.04, (collision.maximumY - collision.minimumY) * 0.18),
  );
  return [
    body,
    {
      ...body,
      shape: collision.supportShape,
      halfWidth: collision.supportHalfWidth,
      halfLength: collision.supportHalfLength,
      minimumY: collision.maximumY - capThickness,
      maximumY: collision.maximumY,
    },
  ];
}

export function simpleCollisionGroupToPhysicsDefinitions(instances) {
  return (instances ?? []).flatMap((instance) => {
    return simpleCollisionInstanceToPhysicsDefinitions(instance);
  });
}
