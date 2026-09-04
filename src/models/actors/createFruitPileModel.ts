import * as THREE from 'three';
import { createSimpleCollisionFromRender } from '../../../shared/actor/simpleCollision.mjs';
import { createFillMaterial, type FillMaterialEnvironment } from '../../materials/createFillMaterial';
import type { ActorRenderDefinition } from '../../scenes/data/SceneDefinition';
import { createOutlinedObject } from '../outlinedObject';
import type { ActorVisualModel } from './ActorVisualModel';

export type FruitPileRender = Extract<ActorRenderDefinition, { model: 'line-art-fruit-pile' }>;

/**
 * 一个果子就是一颗**苹果**：果身加一小截果梗，躺在地上、拿在手上是同一副模型。
 *
 * 果梗只有果身的十分之一大，但它是「这是一颗苹果」和「这是一个球」之间的全部
 * 区别——线稿只有轮廓可用，少了梗，果子在任何角度都读作一颗珠子。
 */

/** 一格堆着好几颗时的摆法；单颗掉落只用原点那一颗。 */
export const FRUIT_PILE_PIECES = [
  { offsetX: -0.36, offsetY: 0.62, offsetZ: -0.20, scale: 1.00, accent: false },
  { offsetX: 0.34, offsetY: 0.58, offsetZ: 0.16, scale: 0.92, accent: false },
  { offsetX: 0.02, offsetY: 0.55, offsetZ: -0.42, scale: 0.86, accent: true },
  { offsetX: -0.02, offsetY: 1.34, offsetZ: -0.06, scale: 0.80, accent: false },
] as const;

/** 果身：略微压扁的球，苹果不是正圆。 */
export function createFruitGeometry(radius: number): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(radius * 0.34, 8, 6);
  geometry.scale(1, 0.9, 1);
  return geometry;
}

/** 果梗：一小截细柱，长在果身顶上。 */
export function createFruitStemGeometry(radius: number): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(radius * 0.035, radius * 0.045, radius * 0.2, 5);
}

/** 果梗相对果身中心抬多高。合批模板和独立模型读同一个数，两条路画出来才是同一颗果子。 */
export function fruitStemOffsetY(radius: number): number {
  return radius * 0.36;
}

/** 独立预览模型（手持物走这条）；地上的高数量掉落由 ThreeHighCountBatchVisual 合批绘制。 */
export function createFruitPileModel(
  environment: FillMaterialEnvironment,
  definition: FruitPileRender,
): ActorVisualModel {
  const root = new THREE.Group();
  const visualRoot = new THREE.Group();
  const outline = new THREE.LineBasicMaterial({ color: definition.inkColor });
  root.add(visualRoot);
  const body = createOutlinedObject(
    createFruitGeometry(definition.radius),
    createFillMaterial(definition.fruitColor, environment),
    24,
    outline,
  );
  const stem = createOutlinedObject(
    createFruitStemGeometry(definition.radius),
    createFillMaterial(definition.accentColor, environment),
    24,
    outline,
  );
  stem.position.y = fruitStemOffsetY(definition.radius);
  visualRoot.add(body, stem);
  return {
    root,
    visualRoot,
    length: definition.radius * 2,
    width: definition.radius * 2,
    simpleCollision: createSimpleCollisionFromRender(definition),
    interactionAnchorY: definition.height + 0.4,
  };
}
