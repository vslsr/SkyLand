import { lerpAngle } from '../../shared/playerMovement.mjs';
import { INTERPOLATION_DELAY_MS, SNAPSHOT_BUFFER_SIZE } from '../../shared/networkTuning.mjs';
import type {
  InterpolatedPlayerState,
  RoomSnapshot,
  SnapshotPlayer,
  SnapshotSlimeDrag,
} from './protocol';

/**
 * 拖拽只在同一次抓取内插值。revision 变了说明玩家松手后重新抓了别的位置，
 * 在两个命中点之间求平均会得到一个谁也没抓过的假位置，所以直接跳到新的一次。
 */
function blendSlimeDrag(
  from: SnapshotSlimeDrag | undefined,
  to: SnapshotSlimeDrag | undefined,
  amount: number,
): SnapshotSlimeDrag | undefined {
  if (!to || !from || from.revision !== to.revision) return to;
  return {
    revision: to.revision,
    // 命中点是抓取身份的一部分，只在换抓取时变；插值它没有意义。
    contactX: to.contactX,
    contactY: to.contactY,
    contactZ: to.contactZ,
    pullX: from.pullX + (to.pullX - from.pullX) * amount,
    pullY: from.pullY + (to.pullY - from.pullY) * amount,
    pullZ: from.pullZ + (to.pullZ - from.pullZ) * amount,
  };
}

function toState(player: SnapshotPlayer): InterpolatedPlayerState {
  return {
    id: player.id,
    name: player.name,
    x: player.x,
    ...(Number.isFinite(player.y) ? { y: player.y } : {}),
    z: player.z,
    yaw: player.yaw,
    speed: player.speed,
    verticalVelocity: player.verticalVelocity,
    velocityX: player.velocityX,
    velocityZ: player.velocityZ,
    grounded: player.grounded,
    ...(player.slimeDrag ? { slimeDrag: player.slimeDrag } : {}),
    ...(player.bitingPlayerId ? { bitingPlayerId: player.bitingPlayerId } : {}),
    ...(player.leash ? { leash: player.leash } : {}),
    ...(player.health ? { health: player.health } : {}),
  };
}

function blend(from: SnapshotPlayer, to: SnapshotPlayer, amount: number): InterpolatedPlayerState {
  const slimeDrag = blendSlimeDrag(from.slimeDrag, to.slimeDrag, amount);
  return {
    id: to.id,
    name: to.name,
    x: from.x + (to.x - from.x) * amount,
    ...(Number.isFinite(from.y) && Number.isFinite(to.y)
      ? { y: from.y! + (to.y! - from.y!) * amount }
      : (Number.isFinite(to.y) ? { y: to.y } : {})),
    z: from.z + (to.z - from.z) * amount,
    yaw: lerpAngle(from.yaw, to.yaw, amount),
    speed: from.speed + (to.speed - from.speed) * amount,
    verticalVelocity: Number.isFinite(from.verticalVelocity) && Number.isFinite(to.verticalVelocity)
      ? from.verticalVelocity! + (to.verticalVelocity! - from.verticalVelocity!) * amount
      : to.verticalVelocity ?? from.verticalVelocity,
    velocityX: Number.isFinite(from.velocityX) && Number.isFinite(to.velocityX)
      ? from.velocityX! + (to.velocityX! - from.velocityX!) * amount
      : to.velocityX ?? from.velocityX,
    velocityZ: Number.isFinite(from.velocityZ) && Number.isFinite(to.velocityZ)
      ? from.velocityZ! + (to.velocityZ! - from.velocityZ!) * amount
      : to.velocityZ ?? from.velocityZ,
    grounded: amount < 0.5 ? from.grounded : to.grounded,
    ...(slimeDrag ? { slimeDrag } : {}),
    // 咬没咬着是离散状态，跟 grounded 一样只取更近的那一份，不插值。
    ...(to.bitingPlayerId ? { bitingPlayerId: to.bitingPlayerId } : {}),
    // 缰绳同样取最新的那一份：它进的是本地预测，插值出来的中间锚点不对应
    // 服务端重放时用过的任何一个值。
    ...(to.leash ? { leash: to.leash } : {}),
    // 血量取最新的那一份：飘字与死亡都靠计数变化触发，插出来的中间值会把
    // 「掉了 30」摊成两帧各掉 15，飘字就成了两条。
    ...(to.health ? { health: to.health } : {}),
  };
}

/**
 * 快照缓冲与插值。
 *
 * 服务端每秒只广播十次状态，直接赋值给远端玩家会明显卡顿。
 * 这里把渲染时间统一回退 INTERPOLATION_DELAY_MS，让每一帧都落在
 * 两份已经收到的快照之间，再做线性插值。
 */
export class SnapshotBuffer {
  private readonly snapshots: RoomSnapshot[] = [];
  private clockOffset?: number;

  public push(snapshot: RoomSnapshot, receivedAt = Date.now()): void {
    // 服务器时钟与本地时钟的偏移取历史最小值（对应延迟最低的一次传输），
    // 再让它缓慢上浮，跟随两端时钟的自然漂移。
    const offsetSample = receivedAt - snapshot.serverTime;
    if (this.clockOffset === undefined || offsetSample < this.clockOffset) {
      this.clockOffset = offsetSample;
    } else {
      this.clockOffset += (offsetSample - this.clockOffset) * 0.01;
    }

    const newest = this.snapshots[this.snapshots.length - 1];
    if (newest && snapshot.serverTime <= newest.serverTime) return;
    this.snapshots.push(snapshot);
    while (this.snapshots.length > SNAPSHOT_BUFFER_SIZE) this.snapshots.shift();
  }

  public clear(): void {
    this.snapshots.length = 0;
    this.clockOffset = undefined;
  }

  public sample(nowMs = Date.now()): InterpolatedPlayerState[] {
    if (this.snapshots.length === 0 || this.clockOffset === undefined) return [];

    const renderTime = nowMs - this.clockOffset - INTERPOLATION_DELAY_MS;
    const newest = this.snapshots[this.snapshots.length - 1];
    // 缓冲被抽干（丢包或卡顿）时保持在最后一份已知状态，不做外推。
    if (renderTime >= newest.serverTime) return newest.players.map(toState);

    const oldest = this.snapshots[0];
    if (renderTime <= oldest.serverTime) return oldest.players.map(toState);

    let index = this.snapshots.length - 1;
    while (index > 0 && this.snapshots[index - 1].serverTime > renderTime) index -= 1;

    const to = this.snapshots[index];
    const from = this.snapshots[index - 1];
    const span = to.serverTime - from.serverTime;
    const amount = span > 0 ? (renderTime - from.serverTime) / span : 1;
    const previous = new Map(from.players.map((player) => [player.id, player]));

    return to.players.map((player) => {
      const earlier = previous.get(player.id);
      return earlier ? blend(earlier, player, amount) : toState(player);
    });
  }
}
