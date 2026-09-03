import { positiveNumber } from './authoringNumber.mjs';
import { color, positive } from './fieldSpec.mjs';

/** 木筏。 */
export const raftModel = {
  id: 'line-art-raft',
  /** Authoring 字段。运行时校验与 actor.schema.json 都读这一份。 */
  fields: {
    foamColor: color(),
    length: positive(30),
    width: positive(30),
  },
  collision: (render) => ({
    halfWidth: positiveNumber(render.width, 1) * 0.5,
    halfLength: positiveNumber(render.length, 1) * 0.5,
    minimumY: -0.24,
    // 甲板可见顶面在根节点上方约 0.47m；旧值 2.3m 把桅杆也包进一个巨型盒，
    // 角色控制器只会撞上一堵隐形墙而无法站上木筏。
    maximumY: 0.47,
  }),
};
