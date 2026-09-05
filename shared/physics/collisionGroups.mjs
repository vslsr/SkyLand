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

/**
 * 弹药扫掠用的查询组。
 *
 * 走 MOVEMENT 而不是 CAMERA，也不新开一层：**能挡住走路的东西挡住箭**，这条不需要
 * 任何 authoring 就对全部地形、墙、静态物件成立。CAMERA 那一层里有树冠这类
 * 「挡镜头不挡人」的形状，箭从枝叶间穿过去是对的，被一团看不见的树冠钉住不是。
 * 真要出现「挡箭但不挡人」的东西时再开第三层，那时它有一个具体的例子可依。
 */
export const PROJECTILE_QUERY_GROUPS = MOVEMENT_QUERY_GROUPS;

export const CAMERA_QUERY_GROUPS = queryInteractionGroups(COLLISION_LAYER.CAMERA);
export const SOLID_COLLIDER_GROUPS = colliderInteractionGroups(COLLISION_LAYER_SOLID);
