import { positiveNumber } from './authoringNumber.mjs';
import { uprightRadialBox } from './authoringShapes.mjs';
import { color, positive } from './fieldSpec.mjs';

/** 石料堆。 */
export const stonePileModel = {
  id: 'line-art-stone-pile',
  traits: { pile: true },
  /** Authoring 字段。运行时校验与 actor.schema.json 都读这一份。 */
  fields: {
    stoneColor: color(),
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
