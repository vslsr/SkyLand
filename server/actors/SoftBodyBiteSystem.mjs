import {
  BITE_COMPONENT,
  SOFT_BODY_DEFORMATION_COMPONENT,
} from '../../shared/actor/index.mjs';

/**
 * 咬住期间的权威推进：形变方向取「被咬者 → 咬人者」的位置方向，长度是咬住之后
 * 两者多分开的距离，所以咬人的一方走开时外壳被扯出一个尖；拉过 `breakDistance`
 * 就自动脱口。
 *
 * 之后地上的倒刺要钩住玩家，走的是同一个 Component：它自己的 System 每 tick
 * 给出施力方的世界位置，剩下的（命中点固定、抓取计数、缰绳、拉断）都已经在那边。
 */
export class SoftBodyBiteSystem {
  update(world) {
    for (const actor of world.query(BITE_COMPONENT)) {
      const bite = actor.requireComponent(BITE_COMPONENT);
      if (!bite.targetActorId) continue;
      const target = world.getActor(bite.targetActorId);
      const deformation = target?.getComponent(SOFT_BODY_DEFORMATION_COMPONENT);
      // 被咬的人离开房间，或者外壳已经被别的来源接管，这张嘴就该松开。
      if (!deformation || deformation.sourceId !== actor.id) {
        bite.release();
        continue;
      }
      // 方向取「被咬者 → 咬人者」的位置方向，所以这里给的是咬人者本人的位置，
      // 不是嘴：嘴离外壳太近，拿它当锚点算出来的位移会指进身体里。
      if (deformation.pullToward(actor.id, target, actor)) continue;
      deformation.release(actor.id);
      bite.release();
    }
  }
}
