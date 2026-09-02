import {
  PICKUP_DROP_COMPONENT,
  TRANSFORM_COMPONENT,
} from '../../shared/actor/index.mjs';

/** 原子建立拾取关系：Component 所有权与 Actor 层级必须同时成功。 */
export function pickupActor(world, actor, holder) {
  const pickupDrop = holder?.getComponent(PICKUP_DROP_COMPONENT);
  const transform = actor?.getComponent(TRANSFORM_COMPONENT);
  if (!pickupDrop || !transform || pickupDrop.heldActorId || actor.parent) return false;
  world.setActorParent(actor.id, holder.id, { worldPositionStays: true });
  transform.setLocalTransform([
    pickupDrop.mouthLocalX,
    pickupDrop.mouthLocalY,
    pickupDrop.mouthLocalZ,
  ], pickupDrop.mouthLocalYaw);
  if (!pickupDrop.pickup(actor.id)) {
    world.setActorParent(actor.id, undefined, { worldPositionStays: true });
    return false;
  }
  return true;
}

/** 保持当前世界姿态解绑；后续掉落物理从这个 Transform 接管。 */
export function dropPickedActor(world, holder) {
  const pickupDrop = holder?.getComponent(PICKUP_DROP_COMPONENT);
  const actor = pickupDrop?.heldActorId ? world.getActor(pickupDrop.heldActorId) : undefined;
  if (!actor || actor.parent?.id !== holder.id) return false;
  world.setActorParent(actor.id, undefined, { worldPositionStays: true });
  return pickupDrop.drop();
}
