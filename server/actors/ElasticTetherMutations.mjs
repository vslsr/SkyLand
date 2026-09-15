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

/**
 * 叼取端点与物件之间的**水平**拉伸长度。
 *
 * 只算 XZ 平面：嘴与地面物件之间那段竖直距离是嘴的高度，是个常数，
 * 跟「你把它拉出去多远」无关。把它算进去，可用拖拽行程就会随起手距离变化——
 * 贴脸按 E 时竖直分量占主导，同样多走一米，长度只涨一点点，于是越贴脸越能拖。
 * 换一只嘴更高的玩家原型（player-slime 0.3 → pbf-slime 0.5）这个偏差就会变大，
 * 正是 pullDistance 想消掉的那种「站多远按决定能拖多久」。
 */
export function elasticTetherStretch(tether, transform) {
  return Math.hypot(tether.targetX - transform.x, tether.targetZ - transform.z);
}

/** 叼取与 interactable 禁用必须作为一个原子状态变化。 */
export function grabElasticTether(tether, interactable, player, transform) {
  if (tether.holderPlayerId || !interactable.enabled) return false;
  if (!updateElasticTetherTarget(tether, player)) return false;
  tether.holderPlayerId = player.id;
  // 拖拽行程从这里起算，玩家站多远按的 E 就不再决定还能拖多久。
  tether.grabLength = elasticTetherStretch(tether, transform);
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
