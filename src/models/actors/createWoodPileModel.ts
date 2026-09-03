import * as THREE from 'three';
import { createSimpleCollisionFromRender } from '../../../shared/actor/simpleCollision.mjs';
import { createFillMaterial, type FillMaterialEnvironment } from '../../materials/createFillMaterial';
import type { ActorRenderDefinition } from '../../scenes/data/SceneDefinition';
import { createOutlinedObject } from '../outlinedObject';
import type { ActorVisualModel } from './ActorVisualModel';

type WoodPileRender = Extract<ActorRenderDefinition, { model: 'line-art-wood-pile' }>;

/** 独立预览模型；实际高数量掉落由 ThreeHighCountBatchVisual 合并绘制。 */
export function createWoodPileModel(
  environment: FillMaterialEnvironment,
  definition: WoodPileRender,
): ActorVisualModel {
  const root = new THREE.Group();
  const visualRoot = new THREE.Group();
  const outline = new THREE.LineBasicMaterial({ color: definition.inkColor });
  root.add(visualRoot);
  for (let index = 0; index < 3; index += 1) {
    const log = createOutlinedObject(
      new THREE.CylinderGeometry(definition.radius * 0.15, definition.radius * 0.15, definition.radius * 1.45, 8),
      createFillMaterial(index === 2 ? definition.cutColor : definition.woodColor, environment),
      6,
      outline,
    );
    log.rotation.z = Math.PI / 2;
    log.rotation.y = index === 2 ? Math.PI / 2 : (index - 0.5) * 0.42;
    log.position.set((index - 1) * definition.radius * 0.22, definition.height * (0.35 + index * 0.18), 0);
    visualRoot.add(log);
  }
  return {
    root,
    visualRoot,
    length: definition.radius * 2,
    width: definition.radius * 2,
    simpleCollision: createSimpleCollisionFromRender(definition),
    interactionAnchorY: definition.height + 0.45,
  };
}
