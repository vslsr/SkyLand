import * as THREE from 'three';
import { createSimpleCollisionFromRender } from '../../../shared/actor/simpleCollision.mjs';
import { createFillMaterial, type FillMaterialEnvironment } from '../../materials/createFillMaterial';
import type { ActorRenderDefinition } from '../../scenes/data/SceneDefinition';
import { createOutlinedObject } from '../outlinedObject';
import type { ActorVisualModel } from './ActorVisualModel';

type FruitPileRender = Extract<ActorRenderDefinition, { model: 'line-art-fruit-pile' }>;

/**
 * 四颗堆在一起的果子，其中一颗用点缀色。摆位写死，和其它堆叠物一样：
 * 掉落物由 HighCountActorBatchSystem 统一绘制，模板必须是确定的一份。
 */
export const FRUIT_PILE_PIECES = [
  { offsetX: -0.36, offsetY: 0.62, offsetZ: -0.20, scale: 1.00, accent: false },
  { offsetX: 0.34, offsetY: 0.58, offsetZ: 0.16, scale: 0.92, accent: false },
  { offsetX: 0.02, offsetY: 0.55, offsetZ: -0.42, scale: 0.86, accent: true },
  { offsetX: -0.02, offsetY: 1.34, offsetZ: -0.06, scale: 0.80, accent: false },
] as const;

export function createFruitGeometry(radius: number): THREE.BufferGeometry {
  return new THREE.SphereGeometry(radius * 0.34, 7, 5);
}

/** 独立预览模型；实际高数量掉落由 HighCountActorBatchSystem 合并绘制。 */
export function createFruitPileModel(
  environment: FillMaterialEnvironment,
  definition: FruitPileRender,
): ActorVisualModel {
  const root = new THREE.Group();
  const visualRoot = new THREE.Group();
  const outline = new THREE.LineBasicMaterial({ color: definition.inkColor });
  root.add(visualRoot);
  for (const piece of FRUIT_PILE_PIECES) {
    const fruit = createOutlinedObject(
      createFruitGeometry(definition.radius * piece.scale),
      createFillMaterial(piece.accent ? definition.accentColor : definition.fruitColor, environment),
      24,
      outline,
    );
    fruit.position.set(
      definition.radius * piece.offsetX,
      definition.height * piece.offsetY,
      definition.radius * piece.offsetZ,
    );
    visualRoot.add(fruit);
  }
  return {
    root,
    visualRoot,
    length: definition.radius * 2,
    width: definition.radius * 2,
    simpleCollision: createSimpleCollisionFromRender(definition),
    interactionAnchorY: definition.height + 0.4,
  };
}
