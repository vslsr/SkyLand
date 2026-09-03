import { positiveNumber } from './authoringNumber.mjs';
import { uprightRadialBox } from './authoringShapes.mjs';

/** 干草堆。 */
export const dryHayModel = {
  id: 'line-art-dry-hay',
  collision: (render) => uprightRadialBox(
    positiveNumber(render.radius, 0.5),
    positiveNumber(render.height, 0.6),
  ),
};
