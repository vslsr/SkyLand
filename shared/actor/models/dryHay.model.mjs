import { positiveNumber } from './authoringNumber.mjs';
import { uprightRadialBox } from './authoringShapes.mjs';
import { color, positive } from './fieldSpec.mjs';

/** 干草堆。 */
export const dryHayModel = {
  id: 'line-art-dry-hay',
  /** Authoring 字段。运行时校验与 actor.schema.json 都读这一份。 */
  fields: {
    color: color(),
    accentColor: color(),
    radius: positive(3),
    height: positive(3),
  },
  collision: (render) => uprightRadialBox(
    positiveNumber(render.radius, 0.5),
    positiveNumber(render.height, 0.6),
  ),
};
