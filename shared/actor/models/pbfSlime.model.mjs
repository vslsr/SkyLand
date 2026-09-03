import { positiveNumber } from './authoringNumber.mjs';
import { uprightCylinder } from './authoringShapes.mjs';

/** 软体史莱姆：外壳可以先包住障碍并形变，内部圆柱只阻止软核心穿透。 */
export const pbfSlimeModel = {
  id: 'line-art-pbf-slime',
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
