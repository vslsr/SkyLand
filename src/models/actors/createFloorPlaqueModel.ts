import * as THREE from 'three';
import { createSimpleCollisionFromRender } from '../../../shared/actor/simpleCollision.mjs';
import { createFillMaterial, type FillMaterialEnvironment } from '../../materials/createFillMaterial';
import type { ActorRenderDefinition } from '../../scenes/data/SceneDefinition';
import { createOutlinedObject } from '../outlinedObject';
import type { ActorVisualModel } from './ActorVisualModel';

type FloorPlaqueRender = Extract<ActorRenderDefinition, { model: 'line-art-floor-plaque' }>;

/** 低矮线稿铭牌；可作为训练区标记或建筑入口地标复用。 */
export function createFloorPlaqueModel(
  environment: FillMaterialEnvironment,
  definition: FloorPlaqueRender,
): ActorVisualModel {
  const root = new THREE.Group();
  const visualRoot = new THREE.Group();
  root.add(visualRoot);
  const plaque = createOutlinedObject(
    new THREE.BoxGeometry(definition.width, definition.height, definition.length),
    createFillMaterial(definition.color, environment),
    1,
    new THREE.LineBasicMaterial({ color: definition.accentColor, transparent: true, opacity: 0.86 }),
  );
  plaque.position.y = definition.height * 0.5;
  visualRoot.add(plaque);
  return {
    root,
    visualRoot,
    length: definition.length,
    width: definition.width,
    simpleCollision: createSimpleCollisionFromRender(definition),
  };
}
