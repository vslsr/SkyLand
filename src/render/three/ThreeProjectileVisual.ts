import type { ProjectileVisualRig } from '../../models/actors/ActorVisualModel';
import type { ProxyId } from '../RenderScene';
import type { RenderTransformBuffer } from '../RenderTransformBuffer';
import { PARAM_PROJECTILE_STOPPED } from '../RenderVisualParams';
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
 * **撞上就碎的那一类**（弹弓的石子）在停住那一刻把模型收起来，改成一团烟尘：
 * 一支箭停住之后还是一支箭——它插在墙上、插在挨打的那只身上，是命中留下的痕迹；
 * 一颗石子停住之后什么都不该剩，地上凭空多出一颗悬着的石头只会让人以为它卡住了。
 * 碎不碎由模型自己说（`shattersOnImpact`），碎成什么样归渲染世界。
 *
 * 每支箭一个实例，随 proxy 建、随 proxy 销毁；上界就是同屏飞着的箭数。
 */
export class ThreeProjectileVisual {
  public constructor(
    private readonly id: ProxyId,
    private readonly rig: ProjectileVisualRig,
  ) {}

  /** 已经碎过了没有。碎只碎一次：停住之后那一位一直是 1。 */
  private shattered = false;

  /**
   * @returns 这一帧是不是**刚刚**碎的。真的话由调用方在它的位置上炸一团烟尘——
   *   烟尘不属于这个 proxy（模型都收起来了），它属于世界。
   */
  public update(transforms: RenderTransformBuffer): boolean {
    this.rig.pitchRoot.rotation.x = transforms.readParam(this.id, PARAM_PROJECTILE_PITCH);
    if (!this.rig.shattersOnImpact || this.shattered) return false;
    if (transforms.readParam(this.id, PARAM_PROJECTILE_STOPPED) < 0.5) return false;
    this.shattered = true;
    this.rig.pitchRoot.visible = false;
    return true;
  }
}
