import { positiveNumber } from './authoringNumber.mjs';

/** 货箱。 */
export const cargoCrateModel = {
  id: 'line-art-cargo-crate',
  collision: (render) => ({
    // 箱盖比主体各向外探出 4 cm；碰撞包住模型的最外沿。
    halfWidth: (positiveNumber(render.width, 0.5) + 0.08) * 0.5,
    halfLength: (positiveNumber(render.length, 0.5) + 0.08) * 0.5,
    minimumY: 0,
    maximumY: positiveNumber(render.height, 0.5) * 0.88,
  }),
};
