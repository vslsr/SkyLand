import { positiveNumber } from './authoringNumber.mjs';
import { uprightCylinder } from './authoringShapes.mjs';
import { color, positive } from './fieldSpec.mjs';

/** 聚能方尖碑。碰撞与训练假人同形，但两者的 authoring 上限不同，各留各的默认值。 */
export const focusObeliskModel = {
  id: 'line-art-focus-obelisk',
  /** Authoring 字段。运行时校验与 actor.schema.json 都读这一份。 */
  fields: {
    stoneColor: color(),
    crystalColor: color(),
    radius: positive(3),
    height: positive(6),
  },
  collision: (render) => uprightCylinder(
    positiveNumber(render.radius, 0.5),
    positiveNumber(render.height, 1),
  ),
};
