import * as THREE from 'three';
import { createSimpleCollisionFromRender } from '../../../shared/actor/simpleCollision.mjs';
import { createFillMaterial, type FillMaterialEnvironment } from '../../materials/createFillMaterial';
import type { ActorRenderDefinition } from '../../scenes/data/SceneDefinition';
import { createOutlinedObject } from '../outlinedObject';
import type { ActorVisualModel } from './ActorVisualModel';

type BuildWallRender = Extract<ActorRenderDefinition, { model: 'line-art-build-wall' }>;

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

/**
 * 墙 / 舷墙：一块沿本地 X 展开的板，两头各一根立柱，顶上一道压条。
 *
 * 原点在墙脚中心，墙从 y=0 长到 height。没有屋顶——topdown 视角下墙只是一道
 * 挡住走路和视线的边，不会遮住站在它后面的人。
 */
export function createBuildWallModel(
  environment: FillMaterialEnvironment,
  definition: BuildWallRender,
): ActorVisualModel {
  const root = new THREE.Group();
  const visualRoot = new THREE.Group();
  root.add(visualRoot);
  const outline = new THREE.LineBasicMaterial({ color: definition.inkColor });
  const { width, height, thickness } = definition;
  const postSize = thickness * 1.5;

  addBox(
    visualRoot,
    [width - postSize, height * 0.92, thickness],
    [0, height * 0.46, 0],
    definition.color,
    environment,
    outline,
  );
  for (const x of [-(width / 2 - postSize / 2), width / 2 - postSize / 2]) {
    addBox(
      visualRoot,
      [postSize, height, postSize],
      [x, height * 0.5, 0],
      definition.accentColor,
      environment,
      outline,
    );
  }
  addBox(
    visualRoot,
    [width, height * 0.06, thickness * 1.3],
    [0, height * 0.95, 0],
    definition.accentColor,
    environment,
    outline,
  );

  return {
    root,
    visualRoot,
    length: thickness,
    width,
    simpleCollision: createSimpleCollisionFromRender(definition),
    interactionAnchorY: height + 0.4,
  };
}
