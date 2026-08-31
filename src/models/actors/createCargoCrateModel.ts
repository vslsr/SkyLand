import * as THREE from 'three';
import { createFillMaterial, type FillMaterialEnvironment } from '../../materials/createFillMaterial';
import type { ActorRenderDefinition } from '../../scenes/data/SceneDefinition';
import { createOutlinedObject } from '../outlinedObject';
import type { ActorVisualModel } from './ActorVisualModel';
import { createSimpleCollisionFromRender } from '../../../shared/actor/simpleCollision.mjs';

type CargoRender = Extract<ActorRenderDefinition, { model: 'line-art-cargo-crate' }>;

function addBox(
  parent: THREE.Object3D,
  size: readonly [number, number, number],
  position: readonly [number, number, number],
  color: string,
  environment: FillMaterialEnvironment,
  outline: THREE.LineBasicMaterial,
): void {
  const object = createOutlinedObject(
    new THREE.BoxGeometry(...size),
    createFillMaterial(color, environment),
    1,
    outline,
  );
  object.position.set(...position);
  parent.add(object);
}

/** 参考魔法小屋置物箱：简化箱体、加宽盖沿、深色束带与正面搭扣。 */
export function createCargoCrateModel(
  environment: FillMaterialEnvironment,
  definition: CargoRender,
): ActorVisualModel {
  const root = new THREE.Group();
  const visualRoot = new THREE.Group();
  root.add(visualRoot);
  const outline = new THREE.LineBasicMaterial({ color: 0x292724 });
  const { width, length, height } = definition;

  addBox(
    visualRoot,
    [width, height * 0.72, length],
    [0, height * 0.36, 0],
    definition.color,
    environment,
    outline,
  );
  addBox(
    visualRoot,
    [width + 0.08, height * 0.16, length + 0.08],
    [0, height * 0.8, 0],
    definition.accentColor,
    environment,
    outline,
  );
  for (const x of [-width * 0.31, width * 0.31]) {
    addBox(
      visualRoot,
      [width * 0.1, height * 0.72, length + 0.035],
      [x, height * 0.36, 0],
      definition.accentColor,
      environment,
      outline,
    );
  }
  addBox(
    visualRoot,
    [width * 0.2, height * 0.22, 0.06],
    [0, height * 0.48, length * 0.52],
    definition.accentColor,
    environment,
    outline,
  );
  return {
    root,
    visualRoot,
    length,
    width,
    simpleCollision: createSimpleCollisionFromRender(definition),
  };
}
