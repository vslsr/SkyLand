import {
  BITE_COMPONENT,
  PICKUP_DROP_COMPONENT,
  SOFT_BODY_DEFORMATION_COMPONENT,
} from '../../shared/actor/index.mjs';
import { mouthWorld, actorWorldToLocal } from '../../shared/softBodyDeformation.mjs';

/**
 * 咬住期间的权威推进：位移是嘴相对命中点的偏移，所以咬人的一方走开时，被咬者
 * 的外壳会被拉长；拉过 `breakDistance` 就自动脱口。
 *
 * 形变本身不是玩法：这里不掉血、不减速、也不移动任何一方，只更新被咬者
 * `SoftBodyDeformationComponent` 上那七个会被复制出去的数。
 *
 * 之后地上的倒刺要钩住玩家，走的是同一个 Component：它自己的 System 每 tick
 * 给出一个世界锚点，剩下的（命中点固定、抓取计数、拉断）都已经在那边。
 */
export class SoftBodyBiteSystem {
  update(world) {
    for (const actor of world.query(BITE_COMPONENT, PICKUP_DROP_COMPONENT)) {
      const bite = actor.requireComponent(BITE_COMPONENT);
      if (!bite.targetActorId) continue;
      const target = world.getActor(bite.targetActorId);
      const deformation = target?.getComponent(SOFT_BODY_DEFORMATION_COMPONENT);
      // 被咬的人离开房间，或者外壳已经被别的来源接管，这张嘴就该松开。
      if (!deformation || deformation.sourceId !== actor.id) {
        bite.release();
        continue;
      }
      const mouth = mouthWorld(actor, actor.requireComponent(PICKUP_DROP_COMPONENT));
      const anchor = actorWorldToLocal(target, target.yaw, mouth, { x: 0, y: 0, z: 0 });
      if (deformation.pullToward(actor.id, anchor)) continue;
      deformation.release(actor.id);
      bite.release();
    }
  }
}
