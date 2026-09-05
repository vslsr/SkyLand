import * as THREE from 'three';
import { createSimpleCollisionFromRender } from '../../../shared/actor/simpleCollision.mjs';
import { createFillMaterial, type FillMaterialEnvironment } from '../../materials/createFillMaterial';
import type { ActorRenderDefinition } from '../../scenes/data/SceneDefinition';
import { createOutlinedObject } from '../outlinedObject';
import type { ActorVisualModel } from './ActorVisualModel';

export type ArrowRender = Extract<ActorRenderDefinition, { model: 'line-art-arrow' }>;

/**
 * 一支箭：**杆 + 箭头 + 两片尾羽**。
 *
 * 它现在是一个真的 Actor 的外观。以前不是——以前射出去的箭只是渲染世界里一个池子
 * 里的对象，活半秒钟就收走，因为判定在松手那一刻就结算完了。那套做法的代价是箭
 * 穿墙：它没有位置、没有 tick、没有沿途碰撞，屏幕上那条轨迹和世界没有关系。现在
 * 权威侧真的有一支箭在飞（`ProjectileComponent`），这里画的就是它。
 *
 * 箭沿局部 **+Z** 躺着，头朝 +Z：这和世界里 yaw 为 0 的正前方是同一个方向
 * （见 `weaponImpactPoint`），所以权威 Transform 的 yaw 直接就是它的水平朝向，
 * 不需要再补一次旋转。俯仰是玩法侧从整条弧上解析求出来的一个参数，渲染侧只把它
 * 摆到 `visualRoot` 上（`ThreeProjectileVisual`）——那是表现，不是权威状态。
 *
 * **原点在箭尖，不在箭尾。** 权威位置是扫掠球的球心，也就是这一箭的**前端**：
 * 锚在箭尾的话整支箭会画在它真正位置的前方 0.72 米处，扎中之后更是整根埋进目标
 * 里——看到的是「穿过去了」，而不是「扎上了」。锚在箭尖，俯仰也就绕箭尖转，
 * 插进去那一下杆自然甩在外面。
 *
 * 碰撞盒由 `createSimpleCollisionFromRender` 一并产出，但**箭这一类 Actor 不装它**
 * （见 `ServerActorFactory`）：一支飞在空中的箭不该挡住走路的人。这里仍然给出来，
 * 是因为 `ActorVisualModel` 这个接口对所有模型是同一个形状。
 */

/** 箭头那一段占多长，米。 */
const HEAD_LENGTH = 0.1;
/** 尾羽那一片有多高、多长。 */
const FLETCHING_SIZE = 0.06;
/** 箭杆有多粗，按全长的比例。线稿靠轮廓说话，太细了描边会糊成一条。 */
const SHAFT_RADIUS_RATIO = 0.0194;

export function createArrowModel(
  environment: FillMaterialEnvironment,
  definition: ArrowRender,
): ActorVisualModel {
  const root = new THREE.Group();
  const visualRoot = new THREE.Group();
  root.add(visualRoot);

  const length = definition.length;
  // 几何仍然按「尾在 0、头在 +Z」建（读起来最直白），整支往后挪一个全长，
  // 于是 `visualRoot` 的原点落在箭尖上。俯仰绕的就是这一点。
  const body = new THREE.Group();
  body.position.z = -(length + HEAD_LENGTH);
  visualRoot.add(body);
  const shaftRadius = length * SHAFT_RADIUS_RATIO;
  const outline = new THREE.LineBasicMaterial({ color: definition.inkColor });

  // 圆柱默认沿 Y 立着，转到 +Z 上躺下。原点在箭尾，箭尖朝 +Z。
  const shaftGeometry = new THREE.CylinderGeometry(shaftRadius, shaftRadius, length, 5, 1);
  shaftGeometry.rotateX(Math.PI / 2);
  shaftGeometry.translate(0, 0, length * 0.5);
  body.add(createOutlinedObject(
    shaftGeometry,
    createFillMaterial(definition.shaftColor, environment),
    1.2,
    outline,
  ));

  // 箭头：一个四棱锥，尖端朝 +Z。棱数取 4 而不是更多，是为了描边之后是几条硬边，
  // 一眼看得出这是个尖，而不是一段圆头的杆。
  const headGeometry = new THREE.ConeGeometry(shaftRadius * 2.6, HEAD_LENGTH, 4, 1);
  headGeometry.rotateX(Math.PI / 2);
  headGeometry.translate(0, 0, length + HEAD_LENGTH * 0.5 - 0.01);
  body.add(createOutlinedObject(
    headGeometry,
    createFillMaterial(definition.headColor, environment),
    1,
    outline,
  ));

  // 尾羽：两片薄片交叉插在箭尾。用盒子而不是平面，因为线稿要的是一圈描边，
  // 单面片从背面看是一条线。
  for (const roll of [0, Math.PI / 2]) {
    const fletchingGeometry = new THREE.BoxGeometry(0.004, FLETCHING_SIZE, FLETCHING_SIZE * 1.8);
    fletchingGeometry.translate(0, FLETCHING_SIZE * 0.4, FLETCHING_SIZE * 0.9 + 0.01);
    fletchingGeometry.rotateZ(roll);
    body.add(createOutlinedObject(
      fletchingGeometry,
      createFillMaterial(definition.headColor, environment),
      1,
      outline,
    ));
  }

  return {
    root,
    visualRoot,
    length: length + HEAD_LENGTH,
    width: shaftRadius * 2,
    simpleCollision: createSimpleCollisionFromRender(definition),
    projectileRig: { pitchRoot: visualRoot },
  };
}
