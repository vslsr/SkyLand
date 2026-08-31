import * as THREE from 'three';
import { createSimpleCollisionFromRender } from '../../../shared/actor/simpleCollision.mjs';
import { createFillMaterial, type FillMaterialEnvironment } from '../../materials/createFillMaterial';
import type { ActorRenderDefinition } from '../../scenes/data/SceneDefinition';
import { createOutlinedObject } from '../outlinedObject';
import { sampleEvenlyOnSurface } from '../surfaceSampling';
import type { ActorVisualModel } from './ActorVisualModel';
import {
  createLineArtFireVisual,
  type LineArtFireSource,
} from './createLineArtFireVisual';

type DryHayRender = Extract<ActorRenderDefinition, { model: 'line-art-dry-hay' }>;

/** 低多边形干草堆；零散草梗使用线段，主体保持填充网格配 EdgesGeometry。 */
export function createDryHayModel(
  environment: FillMaterialEnvironment,
  definition: DryHayRender,
): ActorVisualModel {
  const root = new THREE.Group();
  const visualRoot = new THREE.Group();
  root.add(visualRoot);
  const outline = new THREE.LineBasicMaterial({ color: definition.accentColor, transparent: true, opacity: 0.86 });

  const bodyGeometry = new THREE.CylinderGeometry(
    definition.radius * 0.28,
    definition.radius,
    definition.height,
    9,
    3,
  );
  const body = createOutlinedObject(
    bodyGeometry,
    createFillMaterial(definition.color, environment),
    7,
    outline,
  );
  body.position.y = definition.height * 0.5;
  body.rotation.y = 0.18;
  visualRoot.add(body);

  const strawPoints: THREE.Vector3[] = [];
  for (let index = 0; index < 18; index += 1) {
    const angle = index / 18 * Math.PI * 2 + (index % 3) * 0.08;
    const baseRadius = definition.radius * (0.42 + (index % 4) * 0.12);
    strawPoints.push(
      new THREE.Vector3(
        Math.cos(angle) * baseRadius,
        definition.height * (0.08 + (index % 5) * 0.11),
        Math.sin(angle) * baseRadius,
      ),
      new THREE.Vector3(
        Math.cos(angle + 0.12) * baseRadius * 1.15,
        definition.height * (0.35 + (index % 4) * 0.13),
        Math.sin(angle + 0.12) * baseRadius * 1.15,
      ),
    );
  }
  visualRoot.add(new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(strawPoints),
    new THREE.LineBasicMaterial({ color: definition.accentColor, transparent: true, opacity: 0.78 }),
  ));

  // 仅在模型构建时采样：朝上三角形按表面积取候选，再从中均匀选择 4 个发射点。
  // 不要求每个面都出现火焰，并沿法线外移一点，防止 LineLoop 被主体遮挡。
  body.updateMatrix();
  const bodyNormalMatrix = new THREE.Matrix3().getNormalMatrix(body.matrix);
  const fireSources: LineArtFireSource[] = sampleEvenlyOnSurface(bodyGeometry, 4, {
    seed: 0xd7a4_2026,
    // dot(normal, Up) > 0.5：只保留真正朝上的面，不接受略微上倾的侧壁。
    acceptTriangle: (normal) => normal.y > 0.5,
  }).map((sample, index) => {
    const point = sample.point.clone().applyMatrix4(body.matrix);
    const normal = sample.normal.clone().applyMatrix3(bodyNormalMatrix).normalize();
    point.addScaledVector(normal, definition.radius * 0.045);
    return {
      x: point.x,
      y: point.y,
      z: point.z,
      height: definition.radius * (0.44 + (index % 3) * 0.08),
      width: definition.radius * (0.12 + (index % 2) * 0.025),
      phase: index * 1.73,
      speed: 2.7 + (index % 4) * 0.24,
    };
  });
  const fireVisualRig = createLineArtFireVisual(1, fireSources);
  visualRoot.add(fireVisualRig.root);

  return {
    root,
    visualRoot,
    length: definition.radius * 2,
    width: definition.radius * 2,
    simpleCollision: createSimpleCollisionFromRender(definition),
    interactionAnchorY: definition.height + definition.radius * 0.5,
    fireVisualRig,
  };
}
