import * as THREE from 'three';
import { createFillMaterial, type FillMaterialEnvironment } from '../../materials/createFillMaterial';
import { createOutlinedObject } from '../outlinedObject';
import type { ActorArchetypeDefinition } from '../../scenes/data/SceneDefinition';

export interface BuoyancyRaftModel {
  readonly root: THREE.Group;
  readonly visualRoot: THREE.Group;
  readonly length: number;
  readonly width: number;
}

function addOutlinedBox(
  parent: THREE.Object3D,
  size: readonly [number, number, number],
  position: readonly [number, number, number],
  color: THREE.ColorRepresentation,
  environment: FillMaterialEnvironment,
  lineMaterial: THREE.LineBasicMaterial,
): void {
  const object = createOutlinedObject(
    new THREE.BoxGeometry(...size),
    createFillMaterial(color, environment),
    1,
    lineMaterial,
  );
  object.position.set(...position);
  parent.add(object);
}

export function createBuoyancyRaftModel(
  environment: FillMaterialEnvironment,
  definition: ActorArchetypeDefinition['components']['render'],
): BuoyancyRaftModel {
  const root = new THREE.Group();
  root.name = 'raft-authoritative-root';

  const visualRoot = new THREE.Group();
  visualRoot.name = 'raft-visual-root';
  root.add(visualRoot);

  const outline = new THREE.LineBasicMaterial({ color: 0x292724 });
  const { length, width } = definition;
  addOutlinedBox(visualRoot, [width, 0.18, length], [0, 0.38, 0], 0xdfc99f, environment, outline);

  for (const x of [-1.15, 1.15]) {
    for (const z of [-1.35, 1.35]) {
      addOutlinedBox(visualRoot, [0.58, 0.46, 1.65], [x, 0, z], 0xc6dcd9, environment, outline);
    }
  }

  addOutlinedBox(visualRoot, [0.78, 0.7, 0.78], [0.68, 0.82, 0.12], 0xc99f72, environment, outline);
  addOutlinedBox(visualRoot, [0.12, 1.8, 0.12], [-0.45, 1.35, -0.35], 0xbda47e, environment, outline);

  const foamPoints: THREE.Vector3[] = [];
  for (let index = 0; index < 48; index += 1) {
    const angle = (index / 48) * Math.PI * 2;
    const irregularity = 1 + Math.sin(angle * 5 + 0.6) * 0.035;
    foamPoints.push(new THREE.Vector3(
      Math.cos(angle) * (width * 0.58) * irregularity,
      0.19,
      Math.sin(angle) * (length * 0.56) * irregularity,
    ));
  }
  const foam = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(foamPoints),
    new THREE.LineBasicMaterial({
      color: definition.foamColor,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
      fog: true,
    }),
  );
  foam.name = 'raft-waterline';
  visualRoot.add(foam);

  return {
    root,
    visualRoot,
    length,
    width,
  };
}
