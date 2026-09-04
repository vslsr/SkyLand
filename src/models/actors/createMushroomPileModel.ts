import * as THREE from 'three';
import { createSimpleCollisionFromRender } from '../../../shared/actor/simpleCollision.mjs';
import { createFillMaterial, type FillMaterialEnvironment } from '../../materials/createFillMaterial';
import type { ActorRenderDefinition } from '../../scenes/data/SceneDefinition';
import { createOutlinedObject } from '../outlinedObject';
import type { ActorVisualModel } from './ActorVisualModel';

export type MushroomPileRender = Extract<ActorRenderDefinition, { model: 'line-art-mushroom-pile' }>;

/**
 * 一朵拔下来的蘑菇，**和地里长着的那朵是同一副样子**：菌盖加菌柄、同一套比例。
 *
 * 比例照抄 `createElasticMushroomModel`（菌盖压扁到 0.42、菌柄上细下粗），
 * 只是整体小一号。拔出来换一副长相的话，玩家会以为手上这朵是另一种东西。
 */

/** 菌盖压扁到多少。地里那朵也是这个数，两处一起改才不会分家。 */
const CAP_FLATTEN = 0.42;

/** 一格堆着好几朵时的摆法；单朵掉落只用原点那一朵。 */
export const MUSHROOM_PILE_PIECES = [
  { offsetX: -0.34, offsetZ: -0.16, scale: 1.00, yaw: 0.35 },
  { offsetX: 0.32, offsetZ: 0.20, scale: 0.82, yaw: -0.72 },
  { offsetX: 0.04, offsetZ: -0.40, scale: 0.68, yaw: 1.28 },
] as const;

/** 菌柄有多长：总高减去菌盖占掉的那一截。 */
export function mushroomStemHeight(definition: MushroomPileRender, scale = 1): number {
  return Math.max(0.02, (definition.height - definition.radius * CAP_FLATTEN) * scale);
}

export function createMushroomStemGeometry(radius: number, height: number): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(radius * 0.2, radius * 0.31, height, 8, 1);
}

/** 菌盖是压扁的球；压扁写在几何体里，合批模板与独立模型才是同一个形状。 */
export function createMushroomCapGeometry(radius: number): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(radius, 12, 7);
  geometry.scale(1, CAP_FLATTEN, 1);
  return geometry;
}

/** 独立预览模型（手持物走这条）；地上的高数量掉落由 ThreeHighCountBatchVisual 合批绘制。 */
export function createMushroomPileModel(
  environment: FillMaterialEnvironment,
  definition: MushroomPileRender,
): ActorVisualModel {
  const root = new THREE.Group();
  const visualRoot = new THREE.Group();
  const outline = new THREE.LineBasicMaterial({ color: definition.inkColor });
  root.add(visualRoot);

  const stemHeight = mushroomStemHeight(definition);
  const stem = createOutlinedObject(
    createMushroomStemGeometry(definition.radius, stemHeight),
    createFillMaterial(definition.stemColor, environment),
    1,
    outline,
  );
  stem.position.y = stemHeight * 0.5;
  const cap = createOutlinedObject(
    createMushroomCapGeometry(definition.radius),
    createFillMaterial(definition.capColor, environment),
    4,
    outline,
  );
  cap.position.y = stemHeight;
  visualRoot.add(stem, cap);

  return {
    root,
    visualRoot,
    length: definition.radius * 2,
    width: definition.radius * 2,
    simpleCollision: createSimpleCollisionFromRender(definition),
    interactionAnchorY: definition.height + 0.4,
  };
}
