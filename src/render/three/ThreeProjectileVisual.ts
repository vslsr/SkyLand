import type { ProjectileVisualRig } from '../../models/actors/ActorVisualModel';
import type { ProxyId } from '../RenderScene';
import type { RenderTransformBuffer } from '../RenderTransformBuffer';
import { PARAM_PROJECTILE_PITCH } from '../RenderVisualParams';

/**
 * 让一支飞着的箭把箭尖朝向它正在去的地方。
 *
 * 水平航向来自权威 Transform 的 yaw（模型沿 +Z 躺着，和世界的 yaw=0 是同一个方向），
 * 俯仰走参数段：那个角是玩法侧从整条弧上**解析求**出来的切线
 * （`ClientProjectileSystem`），不是这一侧拿两帧位移差出来的。
 *
 * 差分那一版有两个毛病，都只有画面会告诉你：落后一帧；以及**停住之后跟着载体转**
 * ——箭插在走动的史莱姆身上时，它会随着那只史莱姆走路慢慢摆平，而一支扎进身体的
 * 箭该保持扎进去的姿态。
 *
 * 每支箭一个实例，随 proxy 建、随 proxy 销毁；上界就是同屏飞着的箭数。
 */
export class ThreeProjectileVisual {
  public constructor(
    private readonly id: ProxyId,
    private readonly rig: ProjectileVisualRig,
  ) {}

  public update(transforms: RenderTransformBuffer): void {
    this.rig.pitchRoot.rotation.x = transforms.readParam(this.id, PARAM_PROJECTILE_PITCH);
  }
}
