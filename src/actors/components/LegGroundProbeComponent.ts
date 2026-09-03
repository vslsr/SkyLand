import { ActorComponent } from '../../../shared/actor/ActorComponent.mjs';
import {
  SLIME_GROUND_PROBE_AT_REST,
  type SlimeGroundProbeParams,
} from '../../render/RenderSlimeLegs';

export const LEG_GROUND_PROBE_COMPONENT = 'leg-ground-probe';

/** 地面高度查询。玩法侧的地形/碰撞服务提供，这里只当成一个纯函数用。 */
export interface GroundHeightSampler {
  (x: number, z: number): number;
}

export interface LegGroundProbeComponentOptions {
  /** 探针到身体中心的水平距离，通常取一条腿的水平可达范围。 */
  readonly radius: number;
  /**
   * 脚相对身体基准面允许的最大高差。采样值超出这个范围就夹回去——悬崖边上一只
   * 脚不该顺着十米落差伸下去，那既不好看，也让腿的长度变成无界的。
   */
  readonly maximumReach: number;
}

const MINIMUM_RADIUS = 0.05;

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * 采样这个 Actor 脚下的一小片地面，供渲染侧的腿部步态落脚。
 *
 * **为什么采的是身体附近的窗口而不是每只脚**：脚落在哪里是步态解算的结果，
 * 而步态活在渲染世界里（`ThreeSlimeLegVisual`）。按脚采样意味着先把脚的位置从
 * 渲染世界读回来，那是一次被禁止的 Render→Game 回读，而且必然晚一帧。
 *
 * 所以这里每帧只做五次采样：中心加四个轴向探针。次数是常数，与世界尺寸、
 * 腿的条数都无关；越界的部分由 `sampleSlimeGroundProbe` 夹在窗口内。
 *
 * 这个 Component 不 import three，也不持有任何渲染对象——它写出去的是六个 f32。
 * 采样器本身闭包着玩法侧的地形服务（`SceneWorld`），和
 * `GrassDisplacementComponent` 的处境一样。
 */
export class LegGroundProbeComponent extends ActorComponent {
  public readonly radius: number;
  public readonly maximumReach: number;
  /** 最近一次采样结果；`ActorVisualParamSystem` 直接把它写进参数段。 */
  public readonly probe: SlimeGroundProbeParams = { ...SLIME_GROUND_PROBE_AT_REST };

  public constructor(
    private readonly sample: GroundHeightSampler | undefined,
    options: LegGroundProbeComponentOptions,
  ) {
    super(LEG_GROUND_PROBE_COMPONENT);
    this.radius = Math.max(MINIMUM_RADIUS, finiteOr(options.radius, MINIMUM_RADIUS));
    this.maximumReach = Math.max(0, finiteOr(options.maximumReach, 0));
  }

  /**
   * 重采一次窗口。`y` 是这个 Actor 权威 Transform 的脚底高度，既是没有地形服务
   * 时的兜底平面，也是每个探针高差的基准。
   */
  public refresh(x: number, y: number, z: number): void {
    const probe = this.probe;
    probe.radius = this.radius;
    const sample = this.sample;
    if (!sample) {
      // 没有地形服务（固定水面地图、单独跑的测试）时窗口退化成 Actor 自己脚下的
      // 平面。这是「窗口之外用定义好的中性状态」那条规则的最小情形。
      probe.centerY = y;
      probe.eastY = y;
      probe.westY = y;
      probe.southY = y;
      probe.northY = y;
      return;
    }
    probe.centerY = this.clampToReach(sample(x, z), y);
    probe.eastY = this.clampToReach(sample(x + this.radius, z), y);
    probe.westY = this.clampToReach(sample(x - this.radius, z), y);
    probe.southY = this.clampToReach(sample(x, z + this.radius), y);
    probe.northY = this.clampToReach(sample(x, z - this.radius), y);
  }

  /** 上坡下坡都允许，但高差不能超过腿够得着的范围。 */
  private clampToReach(sampled: number, baseY: number): number {
    const height = finiteOr(sampled, baseY);
    const lowest = baseY - this.maximumReach;
    const highest = baseY + this.maximumReach;
    if (height < lowest) return lowest;
    return height > highest ? highest : height;
  }
}
