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
 * 整把弓立在局部 **YZ** 平面上：长轴是 Y（弓立着），弓臂鼓向 +Z、弦落在 -Z——
 * 也就是弓背朝目标、弦贴着射手，和真的端一把弓是同一个姿势。
 *
 * +Z 是这个世界里 yaw 为 0 的正前方（见 `weaponImpactPoint`），而手持体只继承
 * 玩家的 yaw、不另加朝向，所以**弓面必须垂直于射向**：弓面立在 XY 上的话，玩家
 * 是横着端着一把弓往前射的，箭从弓臂侧面穿出去。
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
  // 圆环默认躺在 XY 平面、从 +X 起画。先转半个缺口让弓臂鼓向 +X，再把整个弓面从
  // XY 立到 YZ 上：鼓的那一侧随之朝 +Z，也就是箭飞出去的方向。
  geometry.rotateZ((Math.PI * 2 - LIMB_ARC) * 0.5 + Math.PI);
  geometry.rotateY(-Math.PI / 2);
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

/** 弦落在 Z 的哪一处：圆环缺口那一侧，所以是个负数（在射手这一边）。 */
export function woodBowStringOffset(definition: WoodBowRender): number {
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
  string.position.z = woodBowStringOffset(definition);
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
