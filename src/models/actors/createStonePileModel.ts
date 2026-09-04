import * as THREE from 'three';
import { createSimpleCollisionFromRender } from '../../../shared/actor/simpleCollision.mjs';
import { createFillMaterial, type FillMaterialEnvironment } from '../../materials/createFillMaterial';
import type { ActorRenderDefinition } from '../../scenes/data/SceneDefinition';
import { createOutlinedObject } from '../outlinedObject';
import type { ActorVisualModel } from './ActorVisualModel';

export type StonePileRender = Extract<ActorRenderDefinition, { model: 'line-art-stone-pile' }>;

/**
 * 一块石头就是一颗**压扁的低多边形石子**：躺在地上、拿在手上是同一副模型。
 *
 * 压扁到 0.62 是为了让它一眼是「石子」而不是「小圆球」——石头从岩石上敲下来时
 * 会顺着层理裂开，扁的那一面朝上躺着才是它该有的样子。
 */

/** 一格堆着好几块时的摆法；单块掉落只用原点那一颗。 */
export const STONE_PILE_PIECES = [
  { offsetX: -0.34, offsetY: 0.30, offsetZ: -0.18, scale: 1.00, yaw: 0.42, accent: false },
  { offsetX: 0.30, offsetY: 0.26, offsetZ: 0.22, scale: 0.82, yaw: -0.85, accent: true },
  { offsetX: 0.02, offsetY: 0.62, offsetZ: -0.05, scale: 0.66, yaw: 1.35, accent: false },
] as const;

/** 单块石子的几何体，压扁比例与 `createRockModel` 保持一致。 */
export function createStonePieceGeometry(radius: number): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(radius * 0.46, 0);
  geometry.scale(1.15, 0.62, 0.94);
  return geometry;
}

/** 独立预览模型（手持物走这条）；地上的高数量掉落由 ThreeHighCountBatchVisual 合批绘制。 */
export function createStonePileModel(
  environment: FillMaterialEnvironment,
  definition: StonePileRender,
): ActorVisualModel {
  const root = new THREE.Group();
  const visualRoot = new THREE.Group();
  const outline = new THREE.LineBasicMaterial({ color: definition.inkColor });
  root.add(visualRoot);
  const stone = createOutlinedObject(
    createStonePieceGeometry(definition.radius),
    createFillMaterial(definition.stoneColor, environment),
    0.6,
    outline,
  );
  stone.position.y = definition.height * 0.3;
  visualRoot.add(stone);
  return {
    root,
    visualRoot,
    length: definition.radius * 2,
    width: definition.radius * 2,
    simpleCollision: createSimpleCollisionFromRender(definition),
    interactionAnchorY: definition.height + 0.4,
  };
}
