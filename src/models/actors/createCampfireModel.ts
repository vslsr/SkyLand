import * as THREE from 'three';
import { createSimpleCollisionFromRender } from '../../../shared/actor/simpleCollision.mjs';
import { createFillMaterial, type FillMaterialEnvironment } from '../../materials/createFillMaterial';
import type { ActorRenderDefinition } from '../../scenes/data/SceneDefinition';
import { createOutlinedObject } from '../outlinedObject';
import type { ActorVisualModel } from './ActorVisualModel';
import { createLineArtFireVisual } from './createLineArtFireVisual';

type CampfireRender = Extract<ActorRenderDefinition, { model: 'line-art-campfire' }>;

function outlined(
  geometry: THREE.BufferGeometry,
  color: string,
  environment: FillMaterialEnvironment,
  outline: THREE.LineBasicMaterial,
): THREE.Group {
  return createOutlinedObject(geometry, createFillMaterial(color, environment), 8, outline);
}

/** 可复用篝火 Actor：石圈、交叉木柴和独立的动态火焰 rig。 */
export function createCampfireModel(
  environment: FillMaterialEnvironment,
  definition: CampfireRender,
): ActorVisualModel {
  const root = new THREE.Group();
  const visualRoot = new THREE.Group();
  root.add(visualRoot);
  const outline = new THREE.LineBasicMaterial({ color: 0x2f2822, transparent: true, opacity: 0.88 });
  const radius = definition.radius;

  for (let index = 0; index < 9; index += 1) {
    const angle = index / 9 * Math.PI * 2;
    const stone = outlined(
      new THREE.IcosahedronGeometry(radius * 0.19, 0),
      definition.stoneColor,
      environment,
      outline,
    );
    stone.scale.set(1.15, 0.72, 0.88);
    stone.position.set(
      Math.cos(angle) * radius * 0.72,
      definition.height * 0.12,
      Math.sin(angle) * radius * 0.72,
    );
    stone.rotation.y = -angle;
    visualRoot.add(stone);
  }

  for (const angle of [-Math.PI / 4, Math.PI / 4]) {
    const log = outlined(
      new THREE.CylinderGeometry(radius * 0.09, radius * 0.1, radius * 1.15, 8),
      definition.woodColor,
      environment,
      outline,
    );
    log.position.y = definition.height * 0.23;
    log.rotation.set(Math.PI / 2, 0, angle);
    visualRoot.add(log);
  }

  const ember = outlined(
    new THREE.CylinderGeometry(radius * 0.38, radius * 0.44, definition.height * 0.08, 10),
    definition.emberColor,
    environment,
    outline,
  );
  ember.position.y = definition.height * 0.12;
  visualRoot.add(ember);

  const fireVisualRig = createLineArtFireVisual(radius * 1.18);
  fireVisualRig.root.position.y = definition.height * 0.18;
  visualRoot.add(fireVisualRig.root);

  return {
    root,
    visualRoot,
    length: radius * 2,
    width: radius * 2,
    simpleCollision: createSimpleCollisionFromRender(definition),
    interactionAnchorY: definition.height + radius * 0.8,
    fireVisualRig,
  };
}
