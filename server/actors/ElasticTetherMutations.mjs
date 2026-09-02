import { PICKUP_DROP_COMPONENT } from '../../shared/actor/index.mjs';

/** 把持有者 PickupDrop Component 的口部挂点换算成权威世界端点。 */
export function updateElasticTetherTarget(tether, player) {
  const pickupDrop = player?.getComponent(PICKUP_DROP_COMPONENT);
  if (!pickupDrop) return false;
  const sin = Math.sin(player.yaw);
  const cos = Math.cos(player.yaw);
  tether.targetX = player.x + pickupDrop.mouthLocalX * cos + pickupDrop.mouthLocalZ * sin;
  tether.targetY = player.y + pickupDrop.mouthLocalY;
  tether.targetZ = player.z - pickupDrop.mouthLocalX * sin + pickupDrop.mouthLocalZ * cos;
  return true;
}

/** 叼取与 interactable 禁用必须作为一个原子状态变化。 */
export function grabElasticTether(tether, interactable, player, transform) {
  if (tether.holderPlayerId || !interactable.enabled) return false;
  if (!updateElasticTetherTarget(tether, player)) return false;
  tether.holderPlayerId = player.id;
  // 拖拽行程从这里起算，玩家站多远按的 E 就不再决定还能拖多久。
  tether.grabLength = Math.hypot(
    tether.targetX - transform.x,
    tether.targetY - transform.y,
    tether.targetZ - transform.z,
  );
  tether.revision += 1;
  interactable.enabled = false;
  interactable.revision += 1;
  return true;
}

/** 自动断开或玩家离开时恢复交互，并递增释放事件供客户端触发回弹。 */
export function releaseElasticTether(tether, interactable) {
  if (!tether.holderPlayerId) return false;
  tether.holderPlayerId = null;
  tether.releaseRevision += 1;
  tether.revision += 1;
  interactable.enabled = true;
  interactable.revision += 1;
  return true;
}
