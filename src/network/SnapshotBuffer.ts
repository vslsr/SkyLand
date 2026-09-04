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
    ...(player.action ? { action: player.action } : {}),
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
    // 动作状态不插值：它是离散的「在做什么」，中间值没有含义。相位由开始时刻推导，
    // 所以取哪一份都指向同一条时间轴上的同一拍。
    ...(to.action ? { action: to.action } : {}),
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

  /**
   * 把本地时钟换算成服务端时钟。
   *
   * 动作状态给的是**权威开始时刻**，相位要拿服务端时间轴上的「现在」去减它——
   * 直接拿本地 `Date.now()` 比会被两端时钟差整个偏掉。还没收到任何快照时是
   * undefined。
   */
  public serverTimeAt(nowMs = Date.now()): number | undefined {
    return this.clockOffset === undefined ? undefined : nowMs - this.clockOffset;
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
