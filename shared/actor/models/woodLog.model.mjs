import { positiveNumber } from './authoringNumber.mjs';
import { color, positive } from './fieldSpec.mjs';

/** 圆木：躺着的，长轴在局部 X 上，所以 halfWidth 用 length 而不是 radius。 */
export const woodLogModel = {
  id: 'line-art-wood-log',
  /** 单根圆木有自己的摆法，不只是把整堆缩小。 */
  traits: { pile: true, pileSingle: true },
  /** Authoring 字段。运行时校验与 actor.schema.json 都读这一份。 */
  fields: {
    woodColor: color(),
    cutColor: color(),
    inkColor: color(),
    radius: positive(1),
    length: positive(3),
  },
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
