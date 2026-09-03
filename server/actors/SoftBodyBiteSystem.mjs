import {
  BITE_COMPONENT,
  SOFT_BODY_DEFORMATION_COMPONENT,
} from '../../shared/actor/index.mjs';

/**
 * 咬住期间的权威推进：更新缰绳锚点，拉过 `breakDistance` 自动脱口。
 *
 * 一块外壳可以同时被几张嘴咬着，每张嘴在这里各推进各的——它们在画面上是几个
 * 分别长出来的尖，在玩法上是几根绳，共享固定步取其中绷得最紧的那根。
 *
 * 这里没有一行形状的代码。被咬成什么样由各客户端按两边位置自己算——快照里关于
 * 「咬」只有 `bitingPlayerId` 这一个离散状态，两边的位置又都是权威的。
 *
 * 之后地上的倒刺要钩住玩家，走的是同一个 Component：它自己的 System 每 tick
 * 给出施力方的世界位置，剩下的（缰绳、拉断）都已经在那边。
 */
export class SoftBodyBiteSystem {
  update(world) {
    for (const actor of world.query(BITE_COMPONENT)) {
      const bite = actor.requireComponent(BITE_COMPONENT);
      if (!bite.targetActorId) continue;
      const target = world.getActor(bite.targetActorId);
      const deformation = target?.getComponent(SOFT_BODY_DEFORMATION_COMPONENT);
      // 被咬的人离开房间，或者这张嘴已经不在那块外壳的抓握名单里了，就该松开。
      if (!deformation || !deformation.isHeldBy(actor.id)) {
        bite.release();
        continue;
      }
      if (deformation.updateHold(actor.id, target, actor, actor.characterState)) continue;
      deformation.release(actor.id);
      bite.release();
    }
  }
}
