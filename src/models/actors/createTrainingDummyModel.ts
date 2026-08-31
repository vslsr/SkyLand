import * as THREE from 'three';
import { createSimpleCollisionFromRender } from '../../../shared/actor/simpleCollision.mjs';
import { createFillMaterial, type FillMaterialEnvironment } from '../../materials/createFillMaterial';
import type { ActorRenderDefinition } from '../../scenes/data/SceneDefinition';
import { createOutlinedObject } from '../outlinedObject';
import type { ActorVisualModel } from './ActorVisualModel';

type TrainingDummyRender = Extract<ActorRenderDefinition, { model: 'line-art-training-dummy' }>;

function outlined(
  geometry: THREE.BufferGeometry,
  color: string,
  environment: FillMaterialEnvironment,
  threshold = 12,
): THREE.Group {
  return createOutlinedObject(
    geometry,
    createFillMaterial(color, environment),
    threshold,
    new THREE.LineBasicMaterial({ color: 0x26221f, transparent: true, opacity: 0.82 }),
  );
}

function runeLoop(radius: number): THREE.LineLoop {
  const points = Array.from({ length: 30 }, (_, index) => {
    const angle = index / 30 * Math.PI * 2;
    return new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
  });
  return new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color: 0x8e5f47, transparent: true, opacity: 0.65 }),
  );
}

/** 可复用训练假人 Actor；能力实验室只驱动暴露的展示 rig，不拥有模型生命周期。 */
export function createTrainingDummyModel(
  environment: FillMaterialEnvironment,
  definition: TrainingDummyRender,
): ActorVisualModel {
  const root = new THREE.Group();
  const visualRoot = new THREE.Group();
  root.add(visualRoot);
  const scale = definition.height / 2.22;

  const base = outlined(
    new THREE.CylinderGeometry(definition.radius * 0.88, definition.radius, 0.24 * scale, 12),
    definition.accentColor,
    environment,
  );
  base.position.y = 0.12 * scale;
  visualRoot.add(base);

  const post = outlined(
    new THREE.CylinderGeometry(0.12 * scale, 0.16 * scale, 1.45 * scale, 8),
    definition.woodColor,
    environment,
  );
  post.position.y = 0.95 * scale;
  visualRoot.add(post);

  const shoulder = outlined(
    new THREE.BoxGeometry(1.35 * scale, 0.13 * scale, 0.13 * scale),
    definition.woodColor,
    environment,
  );
  shoulder.position.y = 1.32 * scale;
  visualRoot.add(shoulder);

  for (const side of [-1, 1]) {
    const arm = outlined(
      new THREE.CylinderGeometry(0.09 * scale, 0.09 * scale, 0.72 * scale, 8),
      definition.accentColor,
      environment,
    );
    arm.position.set(side * 0.62 * scale, 0.94 * scale, 0);
    arm.rotation.z = side * 0.22;
    visualRoot.add(arm);
  }

  const core = new THREE.Group();
  core.name = 'ability-target-core';
  core.position.set(0, 1.72 * scale, 0);
  core.userData.baseY = core.position.y;
  core.add(outlined(
    new THREE.IcosahedronGeometry(0.5 * scale, 1),
    definition.accentColor,
    environment,
    18,
  ));
  for (const radius of [0.34, 0.48]) {
    const loop = runeLoop(radius * scale);
    loop.rotation.x = Math.PI / 2;
    loop.position.z = 0.51 * scale;
    core.add(loop);
  }
  visualRoot.add(core);

  const burningAura = new THREE.Group();
  burningAura.name = 'ability-target-burning-aura';
  const flameMaterial = new THREE.MeshBasicMaterial({
    color: 0xd97843,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
  });
  for (let index = 0; index < 9; index += 1) {
    const flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.08 * scale, 0.34 * scale, 6),
      flameMaterial,
    );
    const angle = index / 9 * Math.PI * 2;
    const baseY = (0.42 + (index % 3) * 0.25) * scale;
    flame.position.set(
      Math.cos(angle) * 0.58 * scale,
      baseY,
      Math.sin(angle) * 0.58 * scale,
    );
    flame.userData.phase = index / 9;
    flame.userData.baseY = baseY;
    burningAura.add(flame);
  }
  burningAura.visible = false;
  visualRoot.add(burningAura);

  return {
    root,
    visualRoot,
    length: definition.radius * 2,
    width: definition.radius * 2,
    simpleCollision: createSimpleCollisionFromRender(definition),
    abilityTargetRig: {
      targetRoot: visualRoot,
      core,
      burningAura,
      targetPoint: core,
    },
  };
}
