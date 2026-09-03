import { leggedSlimeTopY } from '../leggedSlimeShape.mjs';
import { positiveNumber } from './authoringNumber.mjs';
import { uprightCylinder } from './authoringShapes.mjs';

/**
 * 骨骼腿史莱姆。
 *
 * 腿不参与碰撞：它们是贴着地面采样点摆出来的表现，两根细杆挡住玩家只会让这只
 * 史莱姆卡在自己的脚上。权威圆柱仍然从地面一直包到身体顶部。
 */
export const leggedSlimeModel = {
  id: 'line-art-legged-slime',
  /** 两头都能用：带 playerMovement 是玩家外壳，不带就是场景里的野生史莱姆。 */
  traits: { playerShell: true },
  collision: (render) => {
    const radius = positiveNumber(render.radius, 0.42);
    const hipHeight = positiveNumber(render.hipHeight, radius * 1.8);
    return uprightCylinder(radius, leggedSlimeTopY(hipHeight, radius));
  },
};
