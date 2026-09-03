import { positiveNumber } from './authoringNumber.mjs';
import { uprightRadialBox } from './authoringShapes.mjs';

/** 石料堆。 */
export const stonePileModel = {
  id: 'line-art-stone-pile',
  collision: (render) => uprightRadialBox(
    positiveNumber(render.radius, 0.5),
    positiveNumber(render.height, 0.6),
  ),
};
