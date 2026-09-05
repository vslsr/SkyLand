import { holdRatio } from '../../shared/actor/index.mjs';
import type { BallisticPreviewState } from '../render/RenderScene';
import type { SnapshotPlayer } from '../network/protocol';

/**
 * 别人手上那把弓（设计稿 `@i 木弓` 的 `A`，多端那一半）。
 *
 * 拉弓和射出去那一发都是**公开的**：屋里每个人都该看见别人的弓弯没弯、箭飞到哪儿。
 * 权威侧只下发那几个数（蓄力的起止、这一发的落点与计数），怎么画归这一侧——和飘字、
 * 和倒下那段动画是同一个取向。
 *
 * **自己那一份不走这里**：本地按住直接驱动，等一趟网络回来会让弓比物品栏那圈慢
 * 半拍。所以同一个人只会被驱动一次，两条路在调用方就分开了。
 */

export interface RemoteBowPort {
  /** 本地玩家的 id。自己那一份由本地按住驱动，不从快照来。 */
  localPlayerId(): string | undefined;
  /** 这把弓拉了几成。 */
  setBowDraw(actorId: string, charge: number): void;
  /** 这把弓松了（没射出去，或者已经射完了）。 */
  clearBowDraw(actorId: string | undefined): void;
  /** 撒手那一下：弦回弹。 */
  releaseBow(actorId: string): void;
  /** 落点那一格的地面高度，弧的末端要落在地上。 */
  sampleGroundHeight(x: number, z: number): number;
  spawnArrow(state: BallisticPreviewState): void;
}

export interface RemoteBowSyncOptions {
  /**
   * 出手点比脚底高多少。
   *
   * 和本地那条弧读同一个数，否则同一发箭在射手屏幕上从手上出去，在旁观者屏幕上
   * 从脚底出去。
   */
  readonly muzzleHeight: number;
}

export class RemoteBowSync {
  /** 每个人最近一发的计数，用来只射一次。 */
  private readonly shotRevisions = new Map<string, number>();

  public constructor(
    private readonly port: RemoteBowPort,
    private readonly options: RemoteBowSyncOptions,
  ) {}

  public apply(players: readonly SnapshotPlayer[], serverTime: number): void {
    const localPlayerId = this.port.localPlayerId();
    for (const entry of players) {
      if (entry.id === localPlayerId) continue;
      const heldActorId = entry.heldActorId ?? undefined;
      this.applyCharge(entry, heldActorId, serverTime);
      this.applyShot(entry, heldActorId);
    }
  }

  /** 走了的人把记账清掉，这张表才不会随进进出出一直长。 */
  public forget(playerId: string): void {
    this.shotRevisions.delete(playerId);
  }

  /**
   * 拉到几成由这一侧按 `holdRatio` 算，用的是服务端下发的起点与总时长。
   *
   * 两端跑同一个公式，所以旁观者看到的拉弓程度和射手自己看到的是同一个；下发算好
   * 的比例则要每帧都发一次，中间掉一帧弓就卡在半路上。
   */
  private applyCharge(
    entry: SnapshotPlayer,
    heldActorId: string | undefined,
    serverTime: number,
  ): void {
    if (!entry.charge || !heldActorId) {
      this.port.clearBowDraw(heldActorId);
      return;
    }
    this.port.setBowDraw(heldActorId, holdRatio(
      (serverTime - entry.charge.startedAt) / 1000,
      entry.charge.holdSeconds,
    ));
  }

  /**
   * 这一发射出去过没有。
   *
   * 快照里那条**留着不撤**，所以靠计数变化去重；第一次看见一个人时不补射——他进屋
   * 之前射过的那些箭早就落地了，重放一遍只会让人莫名其妙。
   */
  private applyShot(entry: SnapshotPlayer, heldActorId: string | undefined): void {
    const shot = entry.weaponShot;
    if (!shot) return;
    const seen = this.shotRevisions.get(entry.id);
    this.shotRevisions.set(entry.id, shot.revision);
    if (seen === undefined || seen === shot.revision) return;
    if (heldActorId) this.port.releaseBow(heldActorId);
    this.port.spawnArrow({
      originX: shot.x,
      originY: shot.y + this.options.muzzleHeight,
      originZ: shot.z,
      impactX: shot.impactX,
      impactY: this.port.sampleGroundHeight(shot.impactX, shot.impactZ),
      impactZ: shot.impactZ,
      ratio: shot.ratio,
    });
  }
}
