import { positiveNumber } from './authoringNumber.mjs';
import { color, positive } from './fieldSpec.mjs';

/** 礁石：一半埋在地面/水面以下，所以 minimumY 是负的。 */
export const reefModel = {
  id: 'line-art-reef',
  /** Authoring 字段。运行时校验与 actor.schema.json 都读这一份。 */
  fields: {
    color: color(),
    accentColor: color(),
    radius: positive(10),
    height: positive(20),
  },
  collision: (render) => {
    const radius = positiveNumber(render.radius, 0.5);
    const height = positiveNumber(render.height, radius);
    return {
      halfWidth: radius,
      halfLength: radius,
      minimumY: -height * 0.48,
      maximumY: height * 1.08,
    };
  },
};
