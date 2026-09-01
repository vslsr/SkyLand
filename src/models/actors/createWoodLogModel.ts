import * as THREE from 'three';
import { createSimpleCollisionFromRender } from '../../../shared/actor/simpleCollision.mjs';
import { createFillMaterial, type FillMaterialEnvironment } from '../../materials/createFillMaterial';
import type { ActorRenderDefinition } from '../../scenes/data/SceneDefinition';
import { createOutlinedObject } from '../outlinedObject';
import type { ActorVisualModel } from './ActorVisualModel';

export type WoodLogRender = Extract<ActorRenderDefinition, { model: 'line-art-wood-log' }>;

/** 睡眠后的相邻圆木合并时使用的三根小堆布局，单根掉落则只使用原点。 */
export const WOOD_LOG_STACK_LAYOUT = [
  { offsetX: 0, offsetY: 0, offsetZ: 0, yaw: -0.32 },
  { offsetX: -0.08, offsetY: 1.75, offsetZ: 0.22, yaw: 0.38 },
  { offsetX: 0.12, offsetY: 3.35, offsetZ: -0.16, yaw: -0.08 },
] as const;

/**
 * 对齐 line-art-style-magic-cabin-main 的 log：8 边 CylinderGeometry 加 EdgesGeometry。
 * 圆木沿局部 X 轴放置，客户端可让长轴与权威位移推导出的滚动轴对齐。
 */
export function createWoodLogBodyGeometry(radius: number, length: number): THREE.CylinderGeometry {
  const geometry = new THREE.CylinderGeometry(radius, radius, length, 8, 1, false);
  geometry.rotateZ(Math.PI / 2);
  return geometry;
}

/** 两端浅色截面；薄圆柱保留参考模型清楚的八边形端面轮廓。 */
export function createWoodLogCutGeometry(radius: number): THREE.CylinderGeometry {
  const geometry = new THREE.CylinderGeometry(radius * 1.01, radius * 1.01, radius * 0.1, 8, 1, false);
  geometry.rotateZ(Math.PI / 2);
  return geometry;
}

/** 独立预览模型；运行时高数量圆木由 HighCountActorBatchSystem 合批绘制。 */
export function createWoodLogModel(
  environment: FillMaterialEnvironment,
  definition: WoodLogRender,
): ActorVisualModel {
  const root = new THREE.Group();
  const visualRoot = new THREE.Group();
  const outline = new THREE.LineBasicMaterial({ color: definition.inkColor });
  root.add(visualRoot);

  const body = createOutlinedObject(
    createWoodLogBodyGeometry(definition.radius, definition.length),
    createFillMaterial(definition.woodColor, environment),
    1,
    outline,
  );
  visualRoot.add(body);
  for (const side of [-1, 1]) {
    const cut = createOutlinedObject(
      createWoodLogCutGeometry(definition.radius),
      createFillMaterial(definition.cutColor, environment),
      1,
      outline,
    );
    cut.position.x = side * definition.length * 0.505;
    visualRoot.add(cut);
  }

  return {
    root,
    visualRoot,
    length: definition.length,
    width: definition.radius * 2,
    simpleCollision: createSimpleCollisionFromRender(definition),
    interactionAnchorY: definition.radius + 0.4,
  };
}
