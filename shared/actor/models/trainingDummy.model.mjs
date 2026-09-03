import { positiveNumber } from './authoringNumber.mjs';
import { uprightCylinder } from './authoringShapes.mjs';

/** 训练假人。 */
export const trainingDummyModel = {
  id: 'line-art-training-dummy',
  collision: (render) => uprightCylinder(
    positiveNumber(render.radius, 0.5),
    positiveNumber(render.height, 1),
  ),
};
