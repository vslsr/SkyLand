import type { ProjectileVisualRig } from '../../models/actors/ActorVisualModel';
import type { ProxyId } from '../RenderScene';
import type { RenderTransform, RenderTransformBuffer } from '../RenderTransformBuffer';

/**
 * 让一支飞着的箭把箭尖朝向它正在去的地方。
 *
 * 权威 Transform 只带 yaw——那是这一箭的水平航向，射出去之后就不变了。抛物线的
 * 抬头低头是**这一帧的位移方向**，而位移正是渲染世界手上已经有的东西（插值之后
 * 的世界坐标就在 transform SoA 里）。所以俯仰在这一侧求，不过边界：
 * 这和权威 yaw 不进参数段是同一条理由——渲染世界自己算得出来的，别让它绕一圈。
 *
 * 停下之后位移归零，**保持最后一次的角度**：插在墙上的那一支该维持扎进去的姿态，
 * 而不是因为不动了就弹回水平。
 *
 * 每支箭一个实例，随 proxy 建、随 proxy 销毁；上界就是同屏飞着的箭数。
 */

/** 小于这个位移就认为它停住了，米。一帧飞不到 1 毫米的箭没有可信的切线。 */
const MOVEMENT_EPSILON = 1e-3;

export class ThreeProjectileVisual {
  private readonly previous = { x: 0, y: 0, z: 0 };
  private hasPrevious = false;

  public constructor(
    private readonly id: ProxyId,
    private readonly rig: ProjectileVisualRig,
  ) {}

  public update(transforms: RenderTransformBuffer, world: RenderTransform): void {
    transforms.readTransform(this.id, world);
    if (this.hasPrevious) {
      const dx = world.x - this.previous.x;
      const dy = world.y - this.previous.y;
      const dz = world.z - this.previous.z;
      const horizontal = Math.hypot(dx, dz);
      // 水平位移是 0 但竖直不是（几乎垂直落下）时 atan2 仍然给得出角度；
      // 两者都是 0 才是「停住了」，那一帧不动它。
      if (horizontal > MOVEMENT_EPSILON || Math.abs(dy) > MOVEMENT_EPSILON) {
        // 模型沿 +Z 躺着，抬头是绕 X 轴的正向旋转。
        this.rig.pitchRoot.rotation.x = Math.atan2(dy, horizontal);
      }
    }
    this.previous.x = world.x;
    this.previous.y = world.y;
    this.previous.z = world.z;
    this.hasPrevious = true;
  }
}
