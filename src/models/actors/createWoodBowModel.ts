import * as THREE from 'three';
import { createSimpleCollisionFromRender } from '../../../shared/actor/simpleCollision.mjs';
import { createFillMaterial, type FillMaterialEnvironment } from '../../materials/createFillMaterial';
import type { ActorRenderDefinition } from '../../scenes/data/SceneDefinition';
import { createOutlinedObject } from '../outlinedObject';
import type { ActorVisualModel } from './ActorVisualModel';

export type WoodBowRender = Extract<ActorRenderDefinition, { model: 'line-art-wood-bow' }>;

/**
 * 一把木弓：**一段弯木 + 一根直弦**，躺着和拿在手上是同一副模型。
 *
 * 弓臂用一段圆环而不是一根弯曲的柱体：线稿靠轮廓说话，圆环描边之后是两条清晰的
 * 平行弧线，一眼看得出「这是被拉弯的一根木头」。弦是一根细长的六棱柱——用线画的
 * 话 WebGL 会忽略线宽，远处就看不见了，而弦不见了这东西就只剩一段木头。
 *
 * 整把弓立在局部 XY 平面上（弓面朝 Z），弓背朝 -X：手持挂点在原点附近，
 * 玩家转身时弓跟着转，弦始终朝身前。
 */

/** 弓臂张开的角度：不到半圈，两端留出弓梢。 */
const LIMB_ARC = Math.PI * 1.15;

export function createWoodBowLimbGeometry(definition: WoodBowRender): THREE.BufferGeometry {
  const geometry = new THREE.TorusGeometry(
    definition.length * 0.5,
    definition.thickness,
    5,
    18,
    LIMB_ARC,
  );
  // 圆环默认躺在 XY 平面、从 +X 起画。转半个缺口，让开口（弦的那一侧）朝 +X。
  geometry.rotateZ((Math.PI * 2 - LIMB_ARC) * 0.5 + Math.PI);
  return geometry;
}

/** 弦：两个弓梢之间的一根细柱。 */
export function createWoodBowStringGeometry(definition: WoodBowRender): THREE.BufferGeometry {
  const span = definition.length * Math.sin(LIMB_ARC * 0.5);
  const geometry = new THREE.CylinderGeometry(
    definition.thickness * 0.28,
    definition.thickness * 0.28,
    span,
    5,
    1,
  );
  return geometry;
}

/** 弦离弓背多远：圆环开口那一侧的弦高。 */
export function woodBowStringOffsetX(definition: WoodBowRender): number {
  return definition.length * 0.5 * Math.cos(LIMB_ARC * 0.5);
}

export function createWoodBowModel(
  environment: FillMaterialEnvironment,
  definition: WoodBowRender,
): ActorVisualModel {
  const root = new THREE.Group();
  const visualRoot = new THREE.Group();
  const outline = new THREE.LineBasicMaterial({ color: definition.inkColor });
  root.add(visualRoot);

  const limb = createOutlinedObject(
    createWoodBowLimbGeometry(definition),
    createFillMaterial(definition.woodColor, environment),
    1.2,
    outline,
  );
  const string = createOutlinedObject(
    createWoodBowStringGeometry(definition),
    createFillMaterial(definition.stringColor, environment),
    1.2,
    outline,
  );
  string.position.x = woodBowStringOffsetX(definition);
  visualRoot.add(limb, string);
  // 弓立起来：局部 Y 是弓的长轴，掉在地上时由掉落物理自己翻。
  visualRoot.position.y = definition.thickness * 2;

  return {
    root,
    visualRoot,
    length: definition.length,
    width: definition.thickness * 2,
    simpleCollision: createSimpleCollisionFromRender(definition),
    interactionAnchorY: definition.length * 0.5 + 0.4,
  };
}
