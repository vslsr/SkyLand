import { positiveNumber } from './authoringNumber.mjs';

/** 地面铭牌：踩得上去的薄板。 */
export const floorPlaqueModel = {
  id: 'line-art-floor-plaque',
  collision: (render) => ({
    halfWidth: positiveNumber(render.width, 1) * 0.5,
    halfLength: positiveNumber(render.length, 1) * 0.5,
    minimumY: 0,
    maximumY: positiveNumber(render.height, 0.1),
  }),
};
