import { leggedSlimeTopY } from '../leggedSlimeShape.mjs';
import { positiveNumber } from './authoringNumber.mjs';
import { uprightCylinder } from './authoringShapes.mjs';
import { color, integer, number, positive } from './fieldSpec.mjs';

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
  /** Authoring 字段。运行时校验与 actor.schema.json 都读这一份。 */
  fields: {
    radius: positive(2),
    hipHeight: positive(4),
    legSpread: positive(2),
    legCount: integer(2, 6),
    thighLength: positive(3),
    shinLength: positive(3),
    legThickness: positive(0.3),
    footLength: positive(0.6),
    stepLength: positive(3),
    stepHeight: number(0, 2),
    stepDuration: positive(2),
    membraneColor: color(),
    middleColor: color(),
    coreColor: color(),
    bubbleColor: color(),
    inkColor: color(),
    shadowColor: color(),
    legColor: color(),
    footShadowColor: color(),
  },
  /**
   * 站姿下脚就够不到地的话，IK 每帧都在把落脚点往回收，腿会绷成一条直线并且
   * 一直打滑——「骨骼有关节」这件事在画面上直接消失。
   */
  constraints: [
    (v, path) => {
      const standingReach = Math.hypot(v.hipHeight, v.legSpread);
      return v.thighLength + v.shinLength <= standingReach
        ? `${path} 的 thighLength + shinLength 必须够到站姿落脚点（> ${standingReach.toFixed(3)}）`
        : undefined;
    },
  ],
  collision: (render) => {
    const radius = positiveNumber(render.radius, 0.42);
    const hipHeight = positiveNumber(render.hipHeight, radius * 1.8);
    return uprightCylinder(radius, leggedSlimeTopY(hipHeight, radius));
  },
};
