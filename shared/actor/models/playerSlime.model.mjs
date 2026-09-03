import { positiveNumber } from './authoringNumber.mjs';
import { uprightCylinder } from './authoringShapes.mjs';
import { color, positive } from './fieldSpec.mjs';

/** 贴地的球形玩家外壳。碰撞就是那颗球的外接圆柱。 */
export const playerSlimeModel = {
  id: 'line-art-player-slime',
  /** 能当玩家外壳。 */
  traits: { playerShell: true },
  /** Authoring 字段。运行时校验与 actor.schema.json 都读这一份。 */
  fields: {
    radius: positive(2),
    membraneColor: color(),
    middleColor: color(),
    coreColor: color(),
    bubbleColor: color(),
    inkColor: color(),
    shadowColor: color(),
  },
  collision: (render) => {
    const radius = positiveNumber(render.radius, 0.42);
    return uprightCylinder(radius, radius * 2);
  },
};
