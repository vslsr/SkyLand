import * as THREE from 'three';
import { createSimpleCollisionFromRender } from '../../../shared/actor/simpleCollision.mjs';
import { createFillMaterial, type FillMaterialEnvironment } from '../../materials/createFillMaterial';
import type { ActorRenderDefinition } from '../../scenes/data/SceneDefinition';
import { createOutlinedObject } from '../outlinedObject';
import type { ActorVisualModel } from './ActorVisualModel';

export type PelletRender = Extract<ActorRenderDefinition, { model: 'line-art-pellet' }>;

/**
 * 弹弓打出去的那颗石子。
 *
 * 它不像箭那样有头有尾，所以**没有 `projectileRig`**：一颗石子没有「箭尖」，也就
 * 没有俯仰可摆。渲染侧因此不会给它建那套朝向表现——不是漏了，是它本来就不需要。
 *
 * 用一个低面数的多面体而不是球：线稿靠轮廓说话，球描出来是一个圆圈，看不出是块石头。
 */
export function createPelletModel(
  environment: FillMaterialEnvironment,
  definition: PelletRender,
): ActorVisualModel {
  const root = new THREE.Group();
  const visualRoot = new THREE.Group();
  root.add(visualRoot);

  const geometry = new THREE.IcosahedronGeometry(definition.radius, 0);
  // 转一点，免得所有石子都朝同一个面——一堆一模一样的姿态看上去像贴图。
  geometry.rotateY(0.6);
  geometry.rotateX(0.3);
  visualRoot.add(createOutlinedObject(
    geometry,
    createFillMaterial(definition.stoneColor, environment),
    1,
    new THREE.LineBasicMaterial({ color: definition.inkColor }),
  ));

  return {
    root,
    visualRoot,
    length: definition.radius * 2,
    width: definition.radius * 2,
    simpleCollision: createSimpleCollisionFromRender(definition),
  };
}
