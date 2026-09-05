import type { WoodBowVisualRig } from '../../models/actors/ActorVisualModel';
import {
  BOW_RELEASE_SECONDS,
  bowLimbBend,
  bowReleaseLimbBend,
  bowReleaseStringPull,
  bowStringPull,
} from '../RenderBowDraw';
import { PARAM_BOW_CHARGE, PARAM_BOW_RELEASE_REVISION } from '../RenderVisualParams';
import type { ProxyId } from '../RenderScene';
import type { RenderTransformBuffer } from '../RenderTransformBuffer';

/**
 * 拉弓那一下（设计稿 `@i 木弓` 的 `A`：蓄力 / 发射）。
 *
 * 玩法侧只写两个数：拉了几成、撒手计数。拉到几度、弦成什么形状、撒手之后怎么抖，
 * 全在这一侧按 `RenderBowDraw` 那几条曲线积分——这和倒下、和箱盖回弹是同一个取向。
 *
 * 弓臂动的是**枢轴组的角度**，弦动的是三个点里中间那一个，几何一帧都不重建。
 */
export class ThreeWoodBowVisual {
  /** 上一次看到的撒手计数。第一帧看到的那个不触发：它是这把弓出生前的事。 */
  private releaseRevision?: number;
  /** 撒手过了多久；undefined 表示现在没有在抖。 */
  private releaseElapsed?: number;
  /** 撒手那一刻的拉弓量，回弹从它连续地接下去。 */
  private releasePull = 0;
  private releaseBend = 0;

  public constructor(
    private readonly id: ProxyId,
    private readonly rig: WoodBowVisualRig,
  ) {}

  public update(transforms: RenderTransformBuffer, deltaSeconds: number): void {
    const charge = transforms.readParam(this.id, PARAM_BOW_CHARGE);
    const revision = transforms.readParam(this.id, PARAM_BOW_RELEASE_REVISION);
    if (this.releaseRevision === undefined) {
      this.releaseRevision = revision;
    } else if (revision !== this.releaseRevision) {
      this.releaseRevision = revision;
      // 撒手：从这一刻的拉弓量接着往回抖。连发时后一箭接的是前一箭抖到一半的弦。
      this.releasePull = this.currentPull(charge);
      this.releaseBend = this.currentBend(charge);
      this.releaseElapsed = 0;
    }

    if (this.releaseElapsed !== undefined) {
      // 每帧步长封顶：切回标签页那一下的巨大 delta 会把整段抖动一次跳过去。
      this.releaseElapsed += Math.min(deltaSeconds, 0.1);
      if (this.releaseElapsed >= BOW_RELEASE_SECONDS) this.releaseElapsed = undefined;
    }

    this.apply(this.currentBend(charge), this.currentPull(charge));
  }

  private currentBend(charge: number): number {
    return this.releaseElapsed === undefined
      ? bowLimbBend(charge)
      : bowReleaseLimbBend(this.releaseBend, this.releaseElapsed);
  }

  private currentPull(charge: number): number {
    return this.releaseElapsed === undefined
      ? bowStringPull(charge)
      : bowReleaseStringPull(this.releasePull, this.releaseElapsed);
  }

  /**
   * 摆成这一帧的样子。
   *
   * 两条弓臂转的方向相反（上梢往后转，下梢也往后转，但它们在原点两侧，所以角度
   * 反号）；弦的两梢跟着弓臂走，中点按拉开量沿 -Z 后移，于是弦成 V 形。
   */
  private apply(bend: number, pull: number): void {
    this.rig.upperLimb.rotation.x = -bend;
    this.rig.lowerLimb.rotation.x = bend;

    const { stringHalfSpan: span, stringOffsetZ: offsetZ } = this.rig;
    const cos = Math.cos(bend);
    const sin = Math.sin(bend);
    // 弓梢在枢轴组里的静止位置是 (0, ±span, offsetZ)，绕 X 转 ∓bend 之后就是这里。
    const tipY = span * cos + offsetZ * sin;
    const tipZ = offsetZ * cos - span * sin;
    const position = this.rig.string.geometry.getAttribute('position');
    position.setXYZ(0, 0, tipY, tipZ);
    position.setXYZ(1, 0, 0, offsetZ - pull);
    position.setXYZ(2, 0, -tipY, tipZ);
    position.needsUpdate = true;
  }
}
