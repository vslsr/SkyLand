import type { ProjectileVisualRig } from '../../models/actors/ActorVisualModel';
import {
  ballisticArcPitch,
  ballisticArcProgressAt,
  type BallisticArc,
} from '../ballisticArc';
import type { ProxyId } from '../RenderScene';
import type { RenderTransform, RenderTransformBuffer } from '../RenderTransformBuffer';

/**
 * 让一支飞着的箭把箭尖朝向它正在去的地方。
 *
 * 权威 Transform 只带 yaw——那是这一箭的水平航向，射出去之后就不变了。抛物线的
 * 抬头低头由**这一箭走的那条弧**解析求出：弧在射出那一刻就定下来，随 spawn 过来
 * 一次（`MeshProxyDesc.projectileArc`），所以这里只要知道箭现在走到弧的第几成。
 *
 * **朝向是位置的函数，不是「位置之差」的函数。** 这条是这个文件存在的理由：早先
 * 的做法拿两帧插值位置去差分，而复制过来的坐标是量化过的、两帧之间的位移又小，
 * 噪声占的比例因此不低；快照边界上那一下折线转折还会让方向整个跳一格。读起来就是
 * 箭在空中筛糠。换成解析求导之后，位置再抖，箭尖也稳稳指着切线。
 *
 * 停下之后位置不再变，走到的那一成也就不再变，**姿态自然保持**：插在墙上的那一支
 * 维持扎进去的角度，不需要另写一条「停住了就别动它」。
 *
 * 每支箭一个实例，随 proxy 建、随 proxy 销毁；上界就是同屏飞着的箭数。
 */
export class ThreeProjectileVisual {
  public constructor(
    private readonly id: ProxyId,
    private readonly rig: ProjectileVisualRig,
    private readonly arc: BallisticArc | undefined,
  ) {}

  public update(transforms: RenderTransformBuffer, world: RenderTransform): void {
    // 没有弧的弹药（以后可能有直线飞的）就保持水平：编一条弧出来只会让它指错。
    if (!this.arc) return;
    transforms.readTransform(this.id, world);
    const progress = ballisticArcProgressAt(this.arc, world.x, world.z);
    // 模型沿 +Z 躺着；绕 X 正向转会把箭尖压下去，所以抬头要取负。
    this.rig.pitchRoot.rotation.x = -ballisticArcPitch(this.arc, progress);
  }
}
