import { positiveNumber } from './authoringNumber.mjs';
import { uprightRadialBox } from './authoringShapes.mjs';
import { color, positive } from './fieldSpec.mjs';

/** 果实堆。 */
export const fruitPileModel = {
  id: 'line-art-fruit-pile',
  /** 单颗果子有自己的摆法。 */
  traits: { pile: true, pileSingle: true },
  /** Authoring 字段。运行时校验与 actor.schema.json 都读这一份。 */
  fields: {
    fruitColor: color(),
    accentColor: color(),
    inkColor: color(),
    radius: positive(3),
    height: positive(3),
  },
  collision: (render) => uprightRadialBox(
    positiveNumber(render.radius, 0.5),
    positiveNumber(render.height, 0.6),
  ),
};
