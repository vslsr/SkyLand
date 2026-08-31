/** 把玩家朝向换算成史莱姆嘴部的权威世界端点。 */
export function updateElasticTetherTarget(tether, player, transform) {
  tether.targetX = player.x + Math.sin(player.yaw) * tether.mouthForwardOffset;
  tether.targetY = transform.y + tether.mouthHeight;
  tether.targetZ = player.z + Math.cos(player.yaw) * tether.mouthForwardOffset;
}

/** 叼取与 interactable 禁用必须作为一个原子状态变化。 */
export function grabElasticTether(tether, interactable, player, transform) {
  if (tether.holderPlayerId || !interactable.enabled) return false;
  tether.holderPlayerId = player.id;
  updateElasticTetherTarget(tether, player, transform);
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
