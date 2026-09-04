import { HEALTH_COMPONENT } from '../../shared/actor/index.mjs';

/**
 * 尸体到点销毁。
 *
 * 死亡本身在 `HealthMutations` 里当场结算——那是一次事件，不该等到下一帧。
 * 这个 System 只负责那段「躺在地上给人看」的时长：`corpseSeconds` 走完就把
 * Actor 从世界里摘掉。
 *
 * `corpseSeconds` 为 0 的不归它管（玩家就是 0：人还连着，尸体不能凭空消失）。
 *
 * 成本正比于**带生命值的 Actor 数**，不随世界面积增长；房间里一具尸体都没有时
 * 这个循环只是一次空查询。
 */
export class HealthSystem {
  update(world, _deltaSeconds, elapsedSeconds) {
    const now = Number(elapsedSeconds);
    if (!Number.isFinite(now)) return;
    for (const actor of world.query(HEALTH_COMPONENT)) {
      const health = actor.requireComponent(HEALTH_COMPONENT);
      if (!health.dead || health.corpseSeconds <= 0) continue;
      if (!Number.isFinite(health.diedAt)) continue;
      if (now < health.diedAt + health.corpseSeconds) continue;
      // 挂在它身上的东西跟着一起走：尸体没了，钉在它身上的子 Actor 不该留在半空。
      world.removeActorTree(actor.id);
    }
  }
}
