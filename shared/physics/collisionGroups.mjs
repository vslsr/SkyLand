import {
  COLLISION_LAYER,
  COLLISION_LAYER_SOLID,
} from '../collision/collisionLayers.mjs';

const RAPIER_ALL_GROUPS = 0xffff;

/** Rapier packs membership in the high 16 bits and the interaction mask below it. */
export function colliderInteractionGroups(layers = COLLISION_LAYER_SOLID) {
  return ((layers & RAPIER_ALL_GROUPS) << 16) | RAPIER_ALL_GROUPS;
}

export function queryInteractionGroups(layer) {
  const safeLayer = layer & RAPIER_ALL_GROUPS;
  return (safeLayer << 16) | safeLayer;
}

export const MOVEMENT_QUERY_GROUPS = queryInteractionGroups(COLLISION_LAYER.MOVEMENT);
export const CAMERA_QUERY_GROUPS = queryInteractionGroups(COLLISION_LAYER.CAMERA);
export const SOLID_COLLIDER_GROUPS = colliderInteractionGroups(COLLISION_LAYER_SOLID);
