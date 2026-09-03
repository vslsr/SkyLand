import type { ContainerLidVisualRig } from '../../models/actors/ActorVisualModel';
import type { ProxyId } from '../RenderScene';
import type { RenderTransformBuffer } from '../RenderTransformBuffer';
import { PARAM_CONTAINER_OPEN_TARGET } from '../RenderVisualParams';

/** 弹簧刚度与阻尼。参考魔法小屋的箱盖：慢起、快到位、末尾有一点点回坐。 */
const STIFFNESS = 42;
const DAMPING = 9;

/**
 * 箱盖的开合动画。
 *
 * 过边界的只有一个 0 / 1 的目标——「有没有人开着这个箱子」是玩法状态，而从关到开
 * 的那段回弹是表现。把角度本身过网的话，掉帧和快照抖动都会直接抖到盖子上；让它在
 * 这一侧积分，玩法侧每帧只写一个离散位。
 *
 * 用弹簧而不是线性插值，是因为盖子有重量：线性插值到位那一下会硬停，看起来像贴图
 * 切换而不是一块木板被掀起来。
 */
export class ThreeContainerLidVisual {
  /** 当前开合度 [0, 1]。 */
  private openness = 0;
  private velocity = 0;

  public constructor(
    private readonly id: ProxyId,
    private readonly rig: ContainerLidVisualRig,
  ) {}

  public update(transforms: RenderTransformBuffer, deltaSeconds: number): void {
    const target = transforms.readParam(this.id, PARAM_CONTAINER_OPEN_TARGET) >= 0.5 ? 1 : 0;
    // 帧长钳一下：切回标签页那一帧的 delta 可能是好几秒，弹簧会直接发散，
    // 盖子转出好几圈再荡回来。
    const step = Math.min(0.05, Math.max(0, deltaSeconds));
    this.velocity += (target - this.openness) * STIFFNESS * step;
    this.velocity -= this.velocity * Math.min(1, DAMPING * step);
    this.openness += this.velocity * step;
    // 到位就吸附：残余的千分之一角度看不出来，但会让盖子永远处于「正在动」，
    // 拿它做休眠判断的人会一直被吵醒。
    if (Math.abs(target - this.openness) < 0.001 && Math.abs(this.velocity) < 0.001) {
      this.openness = target;
      this.velocity = 0;
    }
    this.rig.lidRoot.rotation.x = this.rig.openAngle * this.openness;
  }
}
