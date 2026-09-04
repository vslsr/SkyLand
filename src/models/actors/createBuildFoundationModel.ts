import * as THREE from 'three';
import { createSimpleCollisionFromRender } from '../../../shared/actor/simpleCollision.mjs';
import { createFillMaterial, type FillMaterialEnvironment } from '../../materials/createFillMaterial';
import type { ActorRenderDefinition } from '../../scenes/data/SceneDefinition';
import { createOutlinedObject } from '../outlinedObject';
import type { ActorVisualModel } from './ActorVisualModel';

type BuildFoundationRender = Extract<ActorRenderDefinition, { model: 'line-art-build-foundation' }>;

/**
 * 地基：一块正方形板，顶面几道木板缝。
 *
 * 原点在板的底面中心，板从 y=0 长到 thickness——放置时只要把它摆到支撑面上，
 * 顶面自然就是「站上去的那一层」。静态地基与水上地基共用这个模型，只是尺寸和配色
 * 来自各自的原型。
 */
export function createBuildFoundationModel(
  environment: FillMaterialEnvironment,
  definition: BuildFoundationRender,
): ActorVisualModel {
  const root = new THREE.Group();
  const visualRoot = new THREE.Group();
  root.add(visualRoot);
  const outline = new THREE.LineBasicMaterial({ color: definition.inkColor });
  const { size, thickness } = definition;

  const slab = createOutlinedObject(
    new THREE.BoxGeometry(size, thickness, size),
    createFillMaterial(definition.plankColor, environment),
    1,
    outline,
  );
  slab.position.y = thickness * 0.5;
  visualRoot.add(slab);

  // 木板缝：几条压在顶面上的细线，按板宽均分。线稿里一块光板读不出材质，
  // 三道缝就够说明「这是拼起来的木板」。
  const seams: THREE.Vector3[] = [];
  const seamCount = 3;
  for (let index = 1; index <= seamCount; index += 1) {
    const x = -size / 2 + (size / (seamCount + 1)) * index;
    seams.push(
      new THREE.Vector3(x, thickness + 0.004, -size / 2 + size * 0.06),
      new THREE.Vector3(x, thickness + 0.004, size / 2 - size * 0.06),
    );
  }
  const seamLines = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(seams),
    new THREE.LineBasicMaterial({ color: definition.accentColor, transparent: true, opacity: 0.85 }),
  );
  seamLines.name = 'build-foundation-seams';
  visualRoot.add(seamLines);

  return {
    root,
    visualRoot,
    length: size,
    width: size,
    simpleCollision: createSimpleCollisionFromRender(definition),
    interactionAnchorY: thickness + 0.6,
  };
}
