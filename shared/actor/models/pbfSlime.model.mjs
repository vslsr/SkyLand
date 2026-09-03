import { positiveNumber } from './authoringNumber.mjs';
import { uprightCylinder } from './authoringShapes.mjs';
import { color, integer, number, positive } from './fieldSpec.mjs';

/** 软体史莱姆：外壳可以先包住障碍并形变，内部圆柱只阻止软核心穿透。 */
export const pbfSlimeModel = {
  id: 'line-art-pbf-slime',
  /** 能当玩家外壳。 */
  traits: { playerShell: true },
  /** Authoring 字段。运行时校验与 actor.schema.json 都读这一份。 */
  fields: {
    radius: positive(2),
    collisionRadius: positive(2),
    collisionHeight: positive(4),
    particleCount: integer(16, 192),
    constraintIterations: integer(1, 5),
    gravity: number(0, 50),
    centerForce: number(0, 100),
    viscosity: number(0, 100),
    bubbleCount: integer(0, 24),
    bubbleSpeed: number(0, 2),
    surfaceColor: color(),
    innerColor: color(),
    highlightColor: color(),
    bubbleColor: color(),
    inkColor: color(),
    shadowColor: color(),
  },
  /**
   * 内部碰撞核心必须真的在外壳里面。等于或超出外壳时，玩家会被一层看不见的
   * 边界挡在蒙皮之外，而画面上蒙皮明明还没碰到。
   */
  constraints: [
    (v, path) => (v.collisionRadius >= v.radius
      ? `${path}.collisionRadius 必须小于外部蒙皮 radius`
      : undefined),
    (v, path) => (v.collisionHeight >= v.radius
      ? `${path}.collisionHeight 必须低于外部蒙皮顶部`
      : undefined),
  ],
  collision: (render) => {
    const radius = positiveNumber(render.radius, 0.9);
    const collisionRadius = Math.min(
      radius * 0.95,
      positiveNumber(render.collisionRadius, radius * 0.55),
    );
    return uprightCylinder(
      collisionRadius,
      positiveNumber(render.collisionHeight, radius * 0.76),
    );
  },
};
