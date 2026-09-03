import { positiveNumber } from './authoringNumber.mjs';
import { color, positive } from './fieldSpec.mjs';

/** 地面铭牌：踩得上去的薄板。 */
export const floorPlaqueModel = {
  id: 'line-art-floor-plaque',
  /** Authoring 字段。运行时校验与 actor.schema.json 都读这一份。 */
  fields: {
    color: color(),
    accentColor: color(),
    width: positive(12),
    length: positive(12),
    height: positive(1),
  },
  collision: (render) => ({
    halfWidth: positiveNumber(render.width, 1) * 0.5,
    halfLength: positiveNumber(render.length, 1) * 0.5,
    minimumY: 0,
    maximumY: positiveNumber(render.height, 0.1),
  }),
};
