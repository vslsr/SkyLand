import { positiveNumber } from './authoringNumber.mjs';
import { uprightRadialBox } from './authoringShapes.mjs';

/** 篝火：石圈外径当碰撞半宽半长。 */
export const campfireModel = {
  id: 'line-art-campfire',
  collision: (render) => uprightRadialBox(
    positiveNumber(render.radius, 0.5),
    positiveNumber(render.height, 0.6),
  ),
};
