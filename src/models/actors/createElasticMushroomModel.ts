import * as THREE from 'three';
import { createSimpleCollisionFromRender } from '../../../shared/actor/simpleCollision.mjs';
import { createFillMaterial, type FillMaterialEnvironment } from '../../materials/createFillMaterial';
import type { ActorRenderDefinition } from '../../scenes/data/SceneDefinition';
import { createOutlinedObject } from '../outlinedObject';
import type { ActorVisualModel } from './ActorVisualModel';

type MushroomRender = Extract<ActorRenderDefinition, { model: 'line-art-elastic-mushroom' }>;

function addSpot(
  capRoot: THREE.Group,
  radius: number,
  position: readonly [number, number, number],
  rotation: readonly [number, number, number],
  color: string,
  environment: FillMaterialEnvironment,
): void {
  const spot = createOutlinedObject(
    new THREE.CircleGeometry(radius, 8),
    createFillMaterial(color, environment),
    1,
    new THREE.LineBasicMaterial({ color: 0x4a382f, transparent: true, opacity: 0.72 }),
  );
  spot.position.set(...position);
  spot.rotation.set(...rotation);
  capRoot.add(spot);
}

/** 低多边形线稿菌盖与独立菌柄；只缩放局部节点，描边会自然跟随拉伸。 */
export function createElasticMushroomModel(
  environment: FillMaterialEnvironment,
  definition: MushroomRender,
): ActorVisualModel {
  const root = new THREE.Group();
  const visualRoot = new THREE.Group();
  const elasticRoot = new THREE.Group();
  const stemRoot = new THREE.Group();
  const capRoot = new THREE.Group();
  root.add(visualRoot);
  visualRoot.add(elasticRoot);
  elasticRoot.add(stemRoot, capRoot);

  const outline = new THREE.LineBasicMaterial({ color: 0x352b27 });
  const restLength = Math.max(0.1, definition.height - definition.radius * 0.46);
  const stem = createOutlinedObject(
    new THREE.CylinderGeometry(
      definition.radius * 0.2,
      definition.radius * 0.31,
      restLength,
      10,
      3,
    ),
    createFillMaterial(definition.stemColor, environment),
    1,
    outline,
  );
  stem.position.y = restLength * 0.5;
  stemRoot.add(stem);

  const cap = createOutlinedObject(
    new THREE.SphereGeometry(definition.radius, 16, 9),
    createFillMaterial(definition.capColor, environment),
    4,
    outline,
  );
  cap.scale.y = 0.42;
  cap.position.y = definition.radius * 0.04;
  capRoot.add(cap);
  capRoot.position.y = restLength;

  addSpot(
    capRoot,
    definition.radius * 0.105,
    [-definition.radius * 0.23, definition.radius * 0.39, definition.radius * 0.05],
    [-Math.PI / 2, 0, -0.32],
    definition.spotColor,
    environment,
  );
  addSpot(
    capRoot,
    definition.radius * 0.085,
    [definition.radius * 0.25, definition.radius * 0.34, definition.radius * 0.16],
    [-1.18, 0.18, 0.42],
    definition.spotColor,
    environment,
  );
  addSpot(
    capRoot,
    definition.radius * 0.07,
    [definition.radius * 0.08, definition.radius * 0.32, -definition.radius * 0.27],
    [-1.02, -2.7, 0.1],
    definition.spotColor,
    environment,
  );

  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(definition.radius * 0.7, 18),
    new THREE.MeshBasicMaterial({
      color: 0x60483d,
      transparent: true,
      opacity: 0.13,
      depthWrite: false,
    }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.012;
  visualRoot.add(shadow);

  return {
    root,
    visualRoot,
    length: definition.radius * 2,
    width: definition.radius * 2,
    simpleCollision: createSimpleCollisionFromRender(definition),
    interactionAnchorY: definition.height + 0.48,
    elasticTetherRig: { elasticRoot, stemRoot, capRoot, restLength },
  };
}
