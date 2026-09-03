import { positiveNumber } from './authoringNumber.mjs';

/** 圆木：躺着的，长轴在局部 X 上，所以 halfWidth 用 length 而不是 radius。 */
export const woodLogModel = {
  id: 'line-art-wood-log',
  collision: (render) => {
    const radius = positiveNumber(render.radius, 0.1);
    return {
      halfWidth: positiveNumber(render.length, 0.8) * 0.5,
      halfLength: radius,
      minimumY: -radius,
      maximumY: radius,
    };
  },
};
