import * as THREE from 'three';
import { createFillMaterial, type FillMaterialEnvironment } from '../materials/createFillMaterial';
import { createOutlinedObject } from './outlinedObject';

/**
 * 一支箭：**杆 + 箭头 + 两片尾羽**。
 *
 * 它不是 Actor，也不是掉落物——射出去的那支箭只活在渲染世界里的半秒钟（判定在松
 * 手那一刻就已经结算完了）。所以这里只造一个 `Object3D`，没有原型、没有碰撞、
 * 没有物品目录条目：给它那一整套，等于承诺它是世界里一件真东西。
 *
 * 箭沿局部 **+Z** 躺着，尾在原点、头在 +Z：飞行时直接用 `lookAt` 对准下一帧的
 * 弧上点，箭尖就朝着飞行方向。这和木弓「开口朝 +Z」是同一套约定
 * （见 `createWoodBowModel`）。
 */

/** 箭有多长，米。比弓短一截：太长了俯视机位下会像一根标枪。 */
export const ARROW_LENGTH = 0.62;
/** 箭杆有多粗。线稿靠轮廓说话，太细了描边会糊成一条。 */
const SHAFT_RADIUS = 0.012;
/** 箭头那一段占全长的多少。 */
const HEAD_LENGTH = 0.1;
/** 尾羽那一片有多高、多长。 */
const FLETCHING_SIZE = 0.06;

export function createArrowModel(
  environment: FillMaterialEnvironment,
  colors: { shaft: string; head: string; ink: string },
): THREE.Group {
  const outline = new THREE.LineBasicMaterial({ color: colors.ink });
  const arrow = new THREE.Group();
  arrow.name = 'arrow';

  // 圆柱默认沿 Y 立着，转到 +Z 上躺下。
  const shaftGeometry = new THREE.CylinderGeometry(SHAFT_RADIUS, SHAFT_RADIUS, ARROW_LENGTH, 5, 1);
  shaftGeometry.rotateX(Math.PI / 2);
  shaftGeometry.translate(0, 0, ARROW_LENGTH * 0.5);
  const shaft = createOutlinedObject(
    shaftGeometry,
    createFillMaterial(colors.shaft, environment),
    1.2,
    outline,
  );

  // 箭头：一个四棱锥，尖端朝 +Z。棱数取 4 而不是更多，是为了描边之后是几条硬边，
  // 一眼看得出这是个尖，而不是一段圆头的杆。
  const headGeometry = new THREE.ConeGeometry(SHAFT_RADIUS * 2.6, HEAD_LENGTH, 4, 1);
  headGeometry.rotateX(Math.PI / 2);
  headGeometry.translate(0, 0, ARROW_LENGTH + HEAD_LENGTH * 0.5 - 0.01);
  const head = createOutlinedObject(
    headGeometry,
    createFillMaterial(colors.head, environment),
    1,
    outline,
  );

  arrow.add(shaft, head);

  // 尾羽：两片薄片交叉插在箭尾。用盒子而不是平面，因为线稿要的是一圈描边，
  // 单面片从背面看是一条线。
  for (const roll of [0, Math.PI / 2]) {
    const fletchingGeometry = new THREE.BoxGeometry(0.004, FLETCHING_SIZE, FLETCHING_SIZE * 1.8);
    fletchingGeometry.translate(0, FLETCHING_SIZE * 0.4, FLETCHING_SIZE * 0.9 + 0.01);
    fletchingGeometry.rotateZ(roll);
    arrow.add(createOutlinedObject(
      fletchingGeometry,
      createFillMaterial(colors.head, environment),
      1,
      outline,
    ));
  }

  return arrow;
}
