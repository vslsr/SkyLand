import { AREA_OF_INTEREST_RADIUS } from '../../shared/networkTuning.mjs';

const RADIUS_SQUARED = AREA_OF_INTEREST_RADIUS * AREA_OF_INTEREST_RADIUS;

function withinRadius(viewer, player) {
  const deltaX = viewer.x - player.x;
  const deltaZ = viewer.z - player.z;
  return deltaX * deltaX + deltaZ * deltaZ <= RADIUS_SQUARED;
}

/**
 * 按观察者的位置裁剪快照。
 *
 * 世界是无限的，一份快照装下全房间玩家既浪费带宽，也让客户端为看不见的人
 * 建模型。观察者自己那条必须始终保留——客户端的预测和解要靠它对账。
 * 兴趣区半径远大于雾的可见距离，所以边界处玩家的进出在画面上看不出来。
 *
 * 找不到观察者时（例如刚加入还没进第一帧）原样返回，宁可多发也不漏发。
 */
export function filterSnapshotForViewer(snapshot, viewerId) {
  const viewer = snapshot.players.find((player) => player.id === viewerId);
  if (!viewer) return snapshot;

  const players = snapshot.players.filter(
    (player) => player.id === viewer.id || withinRadius(viewer, player),
  );
  return players.length === snapshot.players.length ? snapshot : { ...snapshot, players };
}
