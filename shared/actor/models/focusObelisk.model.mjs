import { positiveNumber } from './authoringNumber.mjs';
import { uprightCylinder } from './authoringShapes.mjs';

/** 聚能方尖碑。碰撞与训练假人同形，但两者的 authoring 上限不同，各留各的默认值。 */
export const focusObeliskModel = {
  id: 'line-art-focus-obelisk',
  collision: (render) => uprightCylinder(
    positiveNumber(render.radius, 0.5),
    positiveNumber(render.height, 1),
  ),
};
