import { positiveNumber } from './authoringNumber.mjs';
import { uprightRadialBox } from './authoringShapes.mjs';

/** 果实堆。 */
export const fruitPileModel = {
  id: 'line-art-fruit-pile',
  /** 单颗果子有自己的摆法。 */
  traits: { pile: true, pileSingle: true },
  collision: (render) => uprightRadialBox(
    positiveNumber(render.radius, 0.5),
    positiveNumber(render.height, 0.6),
  ),
};
