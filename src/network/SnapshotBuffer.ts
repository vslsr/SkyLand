import { lerpAngle } from '../../shared/playerMovement.mjs';
import { INTERPOLATION_DELAY_MS, SNAPSHOT_BUFFER_SIZE } from '../../shared/networkTuning.mjs';
import type { InterpolatedPlayerState, RoomSnapshot, SnapshotPlayer } from './protocol';

function toState(player: SnapshotPlayer): InterpolatedPlayerState {
  return { id: player.id, name: player.name, x: player.x, z: player.z, yaw: player.yaw, speed: player.speed };
}

function blend(from: SnapshotPlayer, to: SnapshotPlayer, amount: number): InterpolatedPlayerState {
  return {
    id: to.id,
    name: to.name,
    x: from.x + (to.x - from.x) * amount,
    z: from.z + (to.z - from.z) * amount,
    yaw: lerpAngle(from.yaw, to.yaw, amount),
    speed: from.speed + (to.speed - from.speed) * amount,
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
