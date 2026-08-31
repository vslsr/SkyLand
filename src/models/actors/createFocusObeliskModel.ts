import * as THREE from 'three';
import { createSimpleCollisionFromRender } from '../../../shared/actor/simpleCollision.mjs';
import { createFillMaterial, type FillMaterialEnvironment } from '../../materials/createFillMaterial';
import type { ActorRenderDefinition } from '../../scenes/data/SceneDefinition';
import { createOutlinedObject } from '../outlinedObject';
import type { ActorVisualModel } from './ActorVisualModel';

type FocusObeliskRender = Extract<ActorRenderDefinition, { model: 'line-art-focus-obelisk' }>;

/** 六面石柱与独立水晶构成的通用法术焦点 Actor。 */
export function createFocusObeliskModel(
  environment: FillMaterialEnvironment,
  definition: FocusObeliskRender,
): ActorVisualModel {
  const root = new THREE.Group();
  const visualRoot = new THREE.Group();
  root.add(visualRoot);
  const outline = new THREE.LineBasicMaterial({ color: 0x26221f, transparent: true, opacity: 0.82 });
  const columnHeight = definition.height * 0.73;
  const column = createOutlinedObject(
    new THREE.CylinderGeometry(definition.radius * 0.61, definition.radius, columnHeight, 6),
    createFillMaterial(definition.stoneColor, environment),
    12,
    outline,
  );
  column.position.y = columnHeight * 0.5;
  visualRoot.add(column);

  const crystal = createOutlinedObject(
    new THREE.OctahedronGeometry(definition.radius * 0.84),
    createFillMaterial(definition.crystalColor, environment),
    1,
    outline,
  );
  crystal.name = 'focus-obelisk-crystal';
  crystal.position.y = definition.height * 0.83;
  crystal.scale.y = 1.35;
  visualRoot.add(crystal);

  return {
    root,
    visualRoot,
    length: definition.radius * 2,
    width: definition.radius * 2,
    simpleCollision: createSimpleCollisionFromRender(definition),
  };
}
