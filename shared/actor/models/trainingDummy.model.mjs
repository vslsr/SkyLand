import { positiveNumber } from './authoringNumber.mjs';
import { uprightCylinder } from './authoringShapes.mjs';
import { color, positive } from './fieldSpec.mjs';

/** 训练假人。 */
export const trainingDummyModel = {
  id: 'line-art-training-dummy',
  /** Authoring 字段。运行时校验与 actor.schema.json 都读这一份。 */
  fields: {
    woodColor: color(),
    accentColor: color(),
    radius: positive(3),
    height: positive(6),
  },
  collision: (render) => uprightCylinder(
    positiveNumber(render.radius, 0.5),
    positiveNumber(render.height, 1),
  ),
};
