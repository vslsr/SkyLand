import * as THREE from 'three';
import { createSimpleCollisionFromRender } from '../../../shared/actor/simpleCollision.mjs';
import { createFillMaterial, type FillMaterialEnvironment } from '../../materials/createFillMaterial';
import type { ActorRenderDefinition } from '../../scenes/data/SceneDefinition';
import { createOutlinedObject } from '../outlinedObject';
import type { ActorVisualModel } from './ActorVisualModel';

type StonePileRender = Extract<ActorRenderDefinition, { model: 'line-art-stone-pile' }>;

/**
 * 三块压扁的低多边形石头，形状沿用 `rock.ts` 的手绘石块观感，只是小一号。
 * 每块的位置、朝向与缩放都写死，和木堆一样：掉落物由合批系统统一绘制，
 * 模板必须是确定的一份。
 */
export const STONE_PILE_PIECES = [
  { offsetX: -0.34, offsetY: 0.30, offsetZ: -0.18, scale: 1.00, yaw: 0.42, accent: false },
  { offsetX: 0.30, offsetY: 0.26, offsetZ: 0.22, scale: 0.82, yaw: -0.85, accent: true },
  { offsetX: 0.02, offsetY: 0.62, offsetZ: -0.05, scale: 0.66, yaw: 1.35, accent: false },
] as const;

/** 单块石头的基础几何体，压扁比例与 `createRockModel` 保持一致。 */
export function createStonePieceGeometry(radius: number): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(radius * 0.46, 0);
  geometry.scale(1.15, 0.62, 0.94);
  return geometry;
}

/** 独立预览模型；实际高数量掉落由 HighCountActorBatchSystem 合并绘制。 */
export function createStonePileModel(
  environment: FillMaterialEnvironment,
  definition: StonePileRender,
): ActorVisualModel {
  const root = new THREE.Group();
  const visualRoot = new THREE.Group();
  const outline = new THREE.LineBasicMaterial({ color: definition.inkColor });
  root.add(visualRoot);
  for (const piece of STONE_PILE_PIECES) {
    const stone = createOutlinedObject(
      createStonePieceGeometry(definition.radius * piece.scale),
      createFillMaterial(piece.accent ? definition.accentColor : definition.stoneColor, environment),
      0.6,
      outline,
    );
    stone.rotation.y = piece.yaw;
    stone.position.set(
      definition.radius * piece.offsetX,
      definition.height * piece.offsetY,
      definition.radius * piece.offsetZ,
    );
    visualRoot.add(stone);
  }
  return {
    root,
    visualRoot,
    length: definition.radius * 2,
    width: definition.radius * 2,
    simpleCollision: createSimpleCollisionFromRender(definition),
    interactionAnchorY: definition.height + 0.4,
  };
}
