import { positiveNumber } from './authoringNumber.mjs';

/** 弹性蘑菇：全仓唯一 supportShape 与主形状不同的模型。 */
export const elasticMushroomModel = {
  id: 'line-art-elastic-mushroom',
  collision: (render) => {
    const radius = positiveNumber(render.radius, 0.5);
    return {
      // 根部保持细小；Rapier 适配层会把下面的 supportShape 生成为独立薄菌盖，
      // 因此菌盖顶面可站立，而不再用一根宽盒从地面制造隐形墙。
      halfWidth: radius * 0.4,
      halfLength: radius * 0.4,
      minimumY: 0,
      maximumY: positiveNumber(render.height, 0.9),
      // 支撑 authoring 会成为第二枚薄圆柱 collider，而不是旧查询的特殊分支。
      supportShape: 'cylinder',
      supportHalfWidth: radius,
      supportHalfLength: radius,
    };
  },
};
