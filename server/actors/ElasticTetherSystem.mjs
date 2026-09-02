import {
  ELASTIC_TETHER_COMPONENT,
  ELASTIC_DETACH_COMPONENT,
  INTERACTABLE_COMPONENT,
  TRANSFORM_COMPONENT,
} from '../../shared/actor/index.mjs';
import {
  releaseElasticTether,
  updateElasticTetherTarget,
} from './ElasticTetherMutations.mjs';

/**
 * 仅遍历当前房间最多 256 个 Actor；成本与流式世界面积无关。
 * 玩家位置来自 DS，视觉上的弹簧、弯曲与回弹不参与权威距离判断。
 */
export class ElasticTetherSystem {
  update(world) {
    const players = world.context.players;
    for (const actor of world.query(
      ELASTIC_TETHER_COMPONENT,
      INTERACTABLE_COMPONENT,
      TRANSFORM_COMPONENT,
    )) {
      const tether = actor.requireComponent(ELASTIC_TETHER_COMPONENT);
      if (!tether.holderPlayerId) continue;
      const interactable = actor.requireComponent(INTERACTABLE_COMPONENT);
      const transform = actor.requireComponent(TRANSFORM_COMPONENT);
      const player = players?.get(tether.holderPlayerId);
      if (!player) {
        releaseElasticTether(tether, interactable);
        continue;
      }
      if (!updateElasticTetherTarget(tether, player)) {
        releaseElasticTether(tether, interactable);
        continue;
      }
      const length = Math.hypot(
        tether.targetX - transform.x,
        tether.targetY - transform.y,
        tether.targetZ - transform.z,
      );
      if (length >= tether.breakLength && !actor.getComponent(ELASTIC_DETACH_COMPONENT)) {
        releaseElasticTether(tether, interactable);
      }
    }
  }
}
