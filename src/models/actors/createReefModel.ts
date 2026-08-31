import * as THREE from 'three';
import { createFillMaterial, type FillMaterialEnvironment } from '../../materials/createFillMaterial';
import type { ActorRenderDefinition } from '../../scenes/data/SceneDefinition';
import { createOutlinedObject } from '../outlinedObject';
import type { ActorVisualModel } from './ActorVisualModel';
import { createSimpleCollisionFromRender } from '../../../shared/actor/simpleCollision.mjs';

type ReefRender = Extract<ActorRenderDefinition, { model: 'line-art-reef' }>;

function addRock(
  parent: THREE.Object3D,
  radius: number,
  heightScale: number,
  position: readonly [number, number, number],
  color: string,
  environment: FillMaterialEnvironment,
  outline: THREE.LineBasicMaterial,
): void {
  const rock = createOutlinedObject(
    new THREE.IcosahedronGeometry(radius, 0),
    createFillMaterial(color, environment),
    5,
    outline,
  );
  rock.scale.y = heightScale;
  rock.position.set(...position);
  rock.rotation.set(position[2] * 0.17, position[0] * 0.21, position[0] * 0.08);
  parent.add(rock);
}

/** 低面数岩块簇，保持纸色填充和深色三角轮廓。 */
export function createReefModel(
  environment: FillMaterialEnvironment,
  definition: ReefRender,
): ActorVisualModel {
  const root = new THREE.Group();
  const visualRoot = new THREE.Group();
  root.add(visualRoot);
  const outline = new THREE.LineBasicMaterial({
    color: definition.accentColor,
    transparent: true,
    opacity: 0.86,
  });
  const { radius, height } = definition;
  addRock(visualRoot, radius * 0.72, height / radius, [0, height * 0.34, 0], definition.color, environment, outline);
  addRock(visualRoot, radius * 0.4, 1.65, [-radius * 0.58, height * 0.05, radius * 0.12], definition.color, environment, outline);
  addRock(visualRoot, radius * 0.34, 1.4, [radius * 0.52, 0, radius * 0.28], definition.color, environment, outline);
  addRock(visualRoot, radius * 0.28, 1.25, [radius * 0.2, -height * 0.08, -radius * 0.62], definition.color, environment, outline);
  return {
    root,
    visualRoot,
    length: radius * 2,
    width: radius * 2,
    simpleCollision: createSimpleCollisionFromRender(definition),
  };
}
