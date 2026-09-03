import {
  BITE_COMPONENT,
  PICKUP_DROP_COMPONENT,
  SOFT_BODY_DEFORMATION_COMPONENT,
} from '../../shared/actor/index.mjs';
import { mouthWorld } from '../../shared/softBodyDeformation.mjs';

/**
 * 咬住期间的权威推进：被咬住的那块皮跟着**嘴**走，所以外壳在命中处被扯出一个
 * 尖；咬人的一方退开尖就变长，拉过 `breakDistance` 自动脱口。
 *
 * 之后地上的倒刺要钩住玩家，走的是同一个 Component：它自己的 System 每 tick
 * 给出施力方的世界位置，剩下的（命中点固定、抓取计数、缰绳、拉断）都已经在那边。
 * 倒刺的抓握点就是它自己的位置，所以连最后那个参数都不用给。
 */
export class SoftBodyBiteSystem {
  /** 每 tick 复用的嘴部坐标缓冲，避免热路径分配。 */
  #mouth = { x: 0, y: 0, z: 0 };

  update(world) {
    for (const actor of world.query(BITE_COMPONENT)) {
      const bite = actor.requireComponent(BITE_COMPONENT);
      if (!bite.targetActorId) continue;
      const target = world.getActor(bite.targetActorId);
      const deformation = target?.getComponent(SOFT_BODY_DEFORMATION_COMPONENT);
      const pickupDrop = actor.getComponent(PICKUP_DROP_COMPONENT);
      // 被咬的人离开房间，或者外壳已经被别的来源接管，这张嘴就该松开。
      if (!deformation || !pickupDrop || deformation.sourceId !== actor.id) {
        bite.release();
        continue;
      }
      // 形变的抓握点是嘴，缰绳的锚点是咬人者本人：一个决定那块皮被扯到哪儿，
      // 一个决定被咬者被拴在哪儿，拿嘴当锚点会把绳长凭空缩短半米。
      const mouth = mouthWorld(actor, pickupDrop, this.#mouth);
      if (deformation.pullToward(
        actor.id,
        target,
        actor,
        actor.characterState,
        mouth,
      )) continue;
      deformation.release(actor.id);
      bite.release();
    }
  }
}
