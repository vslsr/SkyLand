import { positiveNumber } from './authoringNumber.mjs';
import { uprightRadialBox } from './authoringShapes.mjs';
import { color, positive } from './fieldSpec.mjs';

/** 篝火：石圈外径当碰撞半宽半长。 */
export const campfireModel = {
  id: 'line-art-campfire',
  /** Authoring 字段。运行时校验与 actor.schema.json 都读这一份。 */
  fields: {
    stoneColor: color(),
    woodColor: color(),
    emberColor: color(),
    radius: positive(3),
    height: positive(3),
  },
  collision: (render) => uprightRadialBox(
    positiveNumber(render.radius, 0.5),
    positiveNumber(render.height, 0.6),
  ),
};
