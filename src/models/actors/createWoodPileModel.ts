import * as THREE from 'three';
import { createSimpleCollisionFromRender } from '../../../shared/actor/simpleCollision.mjs';
import { createFillMaterial, type FillMaterialEnvironment } from '../../materials/createFillMaterial';
import type { ActorRenderDefinition } from '../../scenes/data/SceneDefinition';
import { createOutlinedObject } from '../outlinedObject';
import type { ActorVisualModel } from './ActorVisualModel';

export type WoodPileRender = Extract<ActorRenderDefinition, { model: 'line-art-wood-pile' }>;

/**
 * 一件木头就是一根**六棱柱**：躺在地上、拿在手上是同一副模型。
 *
 * 六条棱是刻意的——线稿风格靠轮廓说话，六边形端面在任何机位下都能数得清边数，
 * 圆柱在描边之后只剩一个椭圆，看不出这是一段被砍下来的木头。
 */

/** 一格堆着好几个时的摆法；单个掉落只用原点那一根。 */
export const WOOD_STACK_LAYOUT = [
  { offsetX: 0, offsetY: 0, offsetZ: 0, yaw: -0.32 },
  { offsetX: -0.08, offsetY: 1.75, offsetZ: 0.22, yaw: 0.38 },
  { offsetX: 0.12, offsetY: 3.35, offsetZ: -0.16, yaw: -0.08 },
] as const;

/** 六棱柱主体，沿局部 X 轴躺着，长轴与掉落时的滚动轴一致。 */
export function createWoodBodyGeometry(radius: number, length: number): THREE.CylinderGeometry {
  const geometry = new THREE.CylinderGeometry(radius, radius, length, 6, 1, false);
  geometry.rotateZ(Math.PI / 2);
  return geometry;
}

/** 两端的浅色截面：一段木头的断口，也是六边形。 */
export function createWoodCutGeometry(radius: number): THREE.CylinderGeometry {
  const geometry = new THREE.CylinderGeometry(radius * 1.01, radius * 1.01, radius * 0.1, 6, 1, false);
  geometry.rotateZ(Math.PI / 2);
  return geometry;
}

/** 独立预览模型（手持物走这条）；地上的高数量掉落由 ThreeHighCountBatchVisual 合批绘制。 */
export function createWoodPileModel(
  environment: FillMaterialEnvironment,
  definition: WoodPileRender,
): ActorVisualModel {
  const root = new THREE.Group();
  const visualRoot = new THREE.Group();
  const outline = new THREE.LineBasicMaterial({ color: definition.inkColor });
  root.add(visualRoot);

  const body = createOutlinedObject(
    createWoodBodyGeometry(definition.radius, definition.length),
    createFillMaterial(definition.woodColor, environment),
    1,
    outline,
  );
  visualRoot.add(body);
  for (const side of [-1, 1]) {
    const cut = createOutlinedObject(
      createWoodCutGeometry(definition.radius),
      createFillMaterial(definition.cutColor, environment),
      1,
      outline,
    );
    cut.position.x = side * definition.length * 0.505;
    visualRoot.add(cut);
  }

  return {
    root,
    visualRoot,
    length: definition.length,
    width: definition.radius * 2,
    simpleCollision: createSimpleCollisionFromRender(definition),
    interactionAnchorY: definition.radius + 0.4,
  };
}
