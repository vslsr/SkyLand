import { positiveNumber } from './authoringNumber.mjs';
import { uprightRadialBox } from './authoringShapes.mjs';

/** 果实堆。 */
export const fruitPileModel = {
  id: 'line-art-fruit-pile',
  collision: (render) => uprightRadialBox(
    positiveNumber(render.radius, 0.5),
    positiveNumber(render.height, 0.6),
  ),
};
