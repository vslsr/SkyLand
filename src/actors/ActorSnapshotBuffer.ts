import { lerpAngle } from '../../shared/playerMovement.mjs';
import { INTERPOLATION_DELAY_MS, SNAPSHOT_BUFFER_SIZE } from '../../shared/networkTuning.mjs';
import type { SnapshotActor } from '../network/protocol';

interface ActorSnapshotFrame {
  serverTime: number;
  actors: readonly SnapshotActor[];
}

function blendNumber(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function blendActor(from: SnapshotActor, to: SnapshotActor, amount: number): SnapshotActor {
  return {
    ...to,
    transform: {
      x: blendNumber(from.transform.x, to.transform.x, amount),
      y: blendNumber(from.transform.y, to.transform.y, amount),
      z: blendNumber(from.transform.z, to.transform.z, amount),
      yaw: lerpAngle(from.transform.yaw, to.transform.yaw, amount),
    },
    // parentActorId 与 localTransform 都是离散复制状态，保留 `to` 的值；
    // 画面只对服务端已经解算好的最终世界 transform 插值。
    ...(from.vessel && to.vessel ? {
      vessel: {
        speed: blendNumber(from.vessel.speed, to.vessel.speed, amount),
        throttle: blendNumber(from.vessel.throttle, to.vessel.throttle, amount),
        steering: blendNumber(from.vessel.steering, to.vessel.steering, amount),
      },
    } : {}),
    ...(from.elasticTether
      && to.elasticTether
      && from.elasticTether.holderPlayerId
      && from.elasticTether.holderPlayerId === to.elasticTether.holderPlayerId
      ? {
          elasticTether: {
            ...to.elasticTether,
            targetX: blendNumber(from.elasticTether.targetX, to.elasticTether.targetX, amount),
            targetY: blendNumber(from.elasticTether.targetY, to.elasticTether.targetY, amount),
            targetZ: blendNumber(from.elasticTether.targetZ, to.elasticTether.targetZ, amount),
          },
        }
      : {}),
  };
}

/** 独立于玩家预测的 Actor 快照缓冲；不外推服务端权威载具。 */
export class ActorSnapshotBuffer {
  private readonly frames: ActorSnapshotFrame[] = [];
  private clockOffset?: number;

  public push(
    actors: readonly SnapshotActor[],
    serverTime: number,
    receivedAt = Date.now(),
  ): boolean {
    const newest = this.frames[this.frames.length - 1];
    if (newest && serverTime <= newest.serverTime) return false;
    const offsetSample = receivedAt - serverTime;
    if (this.clockOffset === undefined || offsetSample < this.clockOffset) {
      this.clockOffset = offsetSample;
    } else {
      this.clockOffset += (offsetSample - this.clockOffset) * 0.01;
    }
    this.frames.push({ serverTime, actors });
    while (this.frames.length > SNAPSHOT_BUFFER_SIZE) this.frames.shift();
    return true;
  }

  public clear(): void {
    this.frames.length = 0;
    this.clockOffset = undefined;
  }

  public sample(nowMs = Date.now()): readonly SnapshotActor[] {
    if (this.frames.length === 0 || this.clockOffset === undefined) return [];
    const renderTime = nowMs - this.clockOffset - INTERPOLATION_DELAY_MS;
    const newest = this.frames[this.frames.length - 1];
    if (renderTime >= newest.serverTime) return newest.actors;
    const oldest = this.frames[0];
    if (renderTime <= oldest.serverTime) return oldest.actors;

    let index = this.frames.length - 1;
    while (index > 0 && this.frames[index - 1].serverTime > renderTime) index -= 1;
    const to = this.frames[index];
    const from = this.frames[index - 1];
    const amount = (renderTime - from.serverTime) / (to.serverTime - from.serverTime);
    const previous = new Map(from.actors.map((actor) => [actor.id, actor]));
    return to.actors.map((actor) => {
      const earlier = previous.get(actor.id);
      return earlier && earlier.archetypeId === actor.archetypeId
        ? blendActor(earlier, actor, amount)
        : actor;
    });
  }
}
