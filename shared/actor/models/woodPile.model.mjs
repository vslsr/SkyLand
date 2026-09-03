import { positiveNumber } from './authoringNumber.mjs';
import { uprightRadialBox } from './authoringShapes.mjs';

/** 木材堆。 */
export const woodPileModel = {
  id: 'line-art-wood-pile',
  collision: (render) => uprightRadialBox(
    positiveNumber(render.radius, 0.5),
    positiveNumber(render.height, 0.6),
  ),
};
