import * as THREE from 'three';
import { createFillMaterial, type FillMaterialEnvironment } from '../../materials/createFillMaterial';
import type { ActorRenderDefinition } from '../../scenes/data/SceneDefinition';
import { createOutlinedObject } from '../outlinedObject';
import type { ActorVisualModel } from './ActorVisualModel';
import { createSimpleCollisionFromRender } from '../../../shared/actor/simpleCollision.mjs';

type ChestRender = Extract<ActorRenderDefinition, { model: 'line-art-storage-chest' }>;

function addBox(
  parent: THREE.Object3D,
  size: readonly [number, number, number],
  position: readonly [number, number, number],
  color: string,
  environment: FillMaterialEnvironment,
  outline: THREE.LineBasicMaterial,
): void {
  const object = createOutlinedObject(
    new THREE.BoxGeometry(...size),
    createFillMaterial(color, environment),
    1,
    outline,
  );
  object.position.set(...position);
  parent.add(object);
}

/**
 * 储物箱：四壁围出的箱体 + 一块绕后沿翻起的盖子。
 *
 * 比例取自 `.cursor/demo/line-art-style-magic-cabin-main` 的楼梯下储物箱——四壁
 * 各一块板、盖沿比箱体宽出一圈、正面一道搭扣短线。
 *
 * **盖子必须是独立的 Group，而且枢轴在后沿**：`lidRoot` 的原点放在箱体背面上棱，
 * 盖板整体前移半个深度。绕自身中心转的话，掀开时盖子会陷进箱体里。旋转由渲染侧
 * 的 `ThreeContainerLidVisual` 驱动，玩法侧只给一个 0 / 1 的目标。
 */
export function createStorageChestModel(
  environment: FillMaterialEnvironment,
  definition: ChestRender,
): ActorVisualModel {
  const root = new THREE.Group();
  const visualRoot = new THREE.Group();
  root.add(visualRoot);
  const outline = new THREE.LineBasicMaterial({ color: 0x292724 });

  const { width, length, height } = definition;
  const body = definition.color;
  const accent = definition.accentColor;
  // 板厚按箱体尺寸取，不另开配置：一个箱子只有一种做工。
  const thickness = Math.min(width, length) * 0.075;
  const wallHeight = height * 0.72;

  addBox(visualRoot, [width, thickness, length], [0, thickness / 2, 0], body, environment, outline);
  for (const z of [length / 2 - thickness / 2, -length / 2 + thickness / 2]) {
    addBox(
      visualRoot,
      [width, wallHeight, thickness],
      [0, thickness + wallHeight / 2, z],
      body,
      environment,
      outline,
    );
  }
  for (const x of [width / 2 - thickness / 2, -width / 2 + thickness / 2]) {
    addBox(
      visualRoot,
      [thickness, wallHeight, length - thickness * 2],
      [x, thickness + wallHeight / 2, 0],
      body,
      environment,
      outline,
    );
  }
  // 前后两道深色束带，压在墙板顶沿上。
  for (const z of [length / 2, -length / 2]) {
    addBox(
      visualRoot,
      [width + thickness, height * 0.1, thickness * 1.6],
      [0, wallHeight + thickness * 0.5, z],
      accent,
      environment,
      outline,
    );
  }
  // 正面搭扣。
  addBox(
    visualRoot,
    [width * 0.22, height * 0.16, thickness * 0.8],
    [0, wallHeight * 0.6, length / 2 + thickness * 0.2],
    accent,
    environment,
    outline,
  );

  const lidRoot = new THREE.Group();
  // 枢轴落在后沿上棱：掀起来时盖子绕着背面转出去，而不是穿进箱体。
  lidRoot.position.set(0, wallHeight + thickness, -length / 2);
  addBox(
    lidRoot,
    [width + thickness, height * 0.14, length + thickness],
    [0, height * 0.07, length / 2],
    accent,
    environment,
    outline,
  );
  visualRoot.add(lidRoot);

  return {
    root,
    visualRoot,
    length,
    width,
    simpleCollision: createSimpleCollisionFromRender(definition),
    containerLidRig: { lidRoot, openAngle: -1.35 },
  };
}
