import { positiveNumber } from './authoringNumber.mjs';
import { uprightCylinder } from './authoringShapes.mjs';

/** 贴地的球形玩家外壳。碰撞就是那颗球的外接圆柱。 */
export const playerSlimeModel = {
  id: 'line-art-player-slime',
  /** 能当玩家外壳。 */
  traits: { playerShell: true },
  collision: (render) => {
    const radius = positiveNumber(render.radius, 0.42);
    return uprightCylinder(radius, radius * 2);
  },
};
