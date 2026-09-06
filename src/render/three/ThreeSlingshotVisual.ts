import type { SlingshotVisualRig } from '../../models/actors/ActorVisualModel';
import {
  BOW_RELEASE_SECONDS,
  SLING_BAND_PULL,
  weaponDrawPull,
  weaponReleasePull,
} from '../RenderWeaponDraw';
import { PARAM_WEAPON_DRAW, PARAM_WEAPON_RELEASE_REVISION } from '../RenderVisualParams';
import type { ProxyId } from '../RenderScene';
import type { RenderTransformBuffer } from '../RenderTransformBuffer';

/**
 * 拉皮筋那一下（设计稿 `@i 弹弓` 的 `A`：蓄力 / 发射）。
 *
 * 和拉弓读的是**同一对参数**（拉了几成 + 撒手计数）和**同一条回弹曲线**：玩法侧
 * 给的本来就是同一个量——物品栏那圈倒计时的比例。两把武器各写一套的话，改回弹
 * 手感要改两处，而漏掉一处不会有人发现。
 *
 * 差别只有两个：拉多开（皮筋比弓弦短），以及**杈不弯**——一把树杈弹弓的力全在
 * 皮筋上，木头是硬的，所以这里没有弓臂那一段。
 */
export class ThreeSlingshotVisual {
  /** 上一次看到的撒手计数。第一帧看到的那个不触发：它是这把弹弓出生前的事。 */
  private releaseRevision?: number;
  /** 撒手过了多久；undefined 表示现在没有在弹。 */
  private releaseElapsed?: number;
  /** 撒手那一刻的拉开量，回弹从它连续地接下去。 */
  private releasePull = 0;

  public constructor(
    private readonly id: ProxyId,
    private readonly rig: SlingshotVisualRig,
  ) {}

  public update(transforms: RenderTransformBuffer, deltaSeconds: number): void {
    const charge = transforms.readParam(this.id, PARAM_WEAPON_DRAW);
    const revision = transforms.readParam(this.id, PARAM_WEAPON_RELEASE_REVISION);
    if (this.releaseRevision === undefined) {
      this.releaseRevision = revision;
    } else if (revision !== this.releaseRevision) {
      this.releaseRevision = revision;
      // 撒手：从这一刻的拉开量接着往回弹。连发时后一发接的是前一发弹到一半的皮筋。
      this.releasePull = this.currentPull(charge);
      this.releaseElapsed = 0;
    }

    if (this.releaseElapsed !== undefined) {
      // 每帧步长封顶：切回标签页那一下的巨大 delta 会把整段回弹一次跳过去。
      this.releaseElapsed += Math.min(deltaSeconds, 0.1);
      if (this.releaseElapsed >= BOW_RELEASE_SECONDS) this.releaseElapsed = undefined;
    }

    this.apply(this.currentPull(charge));
  }

  private currentPull(charge: number): number {
    return this.releaseElapsed === undefined
      ? weaponDrawPull(charge, SLING_BAND_PULL)
      : weaponReleasePull(this.releasePull, this.releaseElapsed);
  }

  /** 皮筋中点与兜一起后移，皮筋于是成 V 形。两个杈头钉死不动。 */
  private apply(pull: number): void {
    const { bandHalfSpan: span, bandHeight: height } = this.rig;
    const position = this.rig.band.geometry.getAttribute('position');
    position.setXYZ(0, -span, height, 0);
    position.setXYZ(1, 0, height, -pull);
    position.setXYZ(2, span, height, 0);
    position.needsUpdate = true;
    this.rig.pouch.position.set(0, height, -pull);
  }
}
