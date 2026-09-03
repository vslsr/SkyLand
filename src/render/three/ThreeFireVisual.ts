import type { LineArtFireVisualRig } from '../../models/actors/ActorVisualModel';
import type { ProxyId } from '../RenderScene';
import type { RenderTransformBuffer } from '../RenderTransformBuffer';
import { PARAM_FIRE_TARGET_INTENSITY } from '../RenderVisualParams';
import type { ThreeMeshProxy } from './ThreeMeshProxy';

/**
 * 复刻参考壁炉的 CPU 动态 LineLoop；只改 visualRoot 下的顶点和火星。
 *
 * 这是渲染世界自己的表现系统（引擎迁移路线图 第 1.5 步）：它不认识 Actor，
 * 只按 proxyId 从边界的参数段读目标强度，rig 本来就住在这边。
 *
 * **平滑住在这里**是有意的——`intensity` 是逐渲染帧的动画状态，不是玩法状态。
 * 那对阈值（吸附 0.002、可见 0.01）也因此留在渲染侧：它们是一对，
 * 参数段用 f32 而不是量化类型，就是为了让 intensity 能精确吸到 0、火焰关得掉。
 *
 * **时钟归属**：`deltaSeconds` 现在仍由模拟侧传进来（过渡形态）。第 3 步渲染
 * 进 worker 之后要换成渲染线程自己的时钟，否则动画会跟着模拟步长抖。
 */
export class ThreeFireVisual {
  /** proxyId → 平滑后的当前强度。渲染侧独占的动画状态。 */
  private readonly intensities = new Map<ProxyId, number>();

  public update(
    proxies: readonly ThreeMeshProxy[],
    transforms: RenderTransformBuffer,
    deltaSeconds: number,
    elapsedSeconds: number,
  ): void {
    const smoothing = 1 - Math.exp(-7 * Math.max(0, Math.min(deltaSeconds, 0.1)));
    const live = new Set<ProxyId>();
    for (const proxy of proxies) {
      const rig = proxy.fireVisualRig;
      if (!rig) continue;
      live.add(proxy.id);
      const target = transforms.readParam(proxy.id, PARAM_FIRE_TARGET_INTENSITY);
      let intensity = this.intensities.get(proxy.id) ?? target;
      intensity += (target - intensity) * smoothing;
      if (Math.abs(target - intensity) < 0.002) intensity = target;
      this.intensities.set(proxy.id, intensity);
      const power = Math.max(0, Math.min(1, intensity));
      rig.root.visible = power > 0.01;
      if (!rig.root.visible) continue;
      for (const flame of rig.flames) this.updateFlame(flame, elapsedSeconds, power);
      for (const spark of rig.sparks) {
        const progress = (elapsedSeconds * 0.22 + spark.phase) % 1;
        spark.object.position.set(
          spark.x + spark.drift * progress
            + Math.sin(elapsedSeconds * 2.5 + spark.phase * 9) * 0.04,
          spark.y + progress * spark.rise,
          spark.z + Math.cos(elapsedSeconds * 2 + spark.phase * 7) * 0.1,
        );
        const scale = ((1 - progress) * 0.9 + 0.15) * (0.35 + 0.65 * power);
        spark.object.scale.setScalar(scale);
      }
    }
  }

  /** 槽位会被复用：proxy 销毁后必须丢掉它的动画状态，否则新 Actor 继承旧强度。 */
  public forget(id: ProxyId): void {
    this.intensities.delete(id);
  }

  private updateFlame(
    flame: LineArtFireVisualRig['flames'][number],
    time: number,
    power: number,
  ): void {
    const positions = flame.position.array as Float32Array;
    const height = flame.height * power;
    const widthScale = 0.3 + 0.7 * power;
    let cursor = 0;
    const writePoint = (step: number, side: number): void => {
      const t = step / flame.segments;
      const width = flame.width * widthScale * Math.sin(Math.PI * (0.16 + 0.84 * t));
      const wobbleX = Math.sin(t * 5.2 - time * flame.speed + flame.phase)
        * 0.028 * t * power;
      const wobbleZ = Math.sin(t * 4 - time * flame.speed * 0.7 + flame.phase * 1.7)
        * 0.02 * t * power;
      positions[cursor++] = flame.x + wobbleX + width * side;
      positions[cursor++] = flame.y + t * height;
      positions[cursor++] = flame.z + wobbleZ;
    };
    for (let step = 0; step <= flame.segments; step += 1) writePoint(step, 1);
    for (let step = flame.segments; step >= 0; step -= 1) writePoint(step, -1);
    flame.position.needsUpdate = true;
  }
}
