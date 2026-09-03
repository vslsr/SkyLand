import { ActorComponent } from '../../../shared/actor/ActorComponent.mjs';

export const FIRE_VISUAL_COMPONENT = 'fire-visual';

/**
 * 玩法侧的燃烧表现状态。
 *
 * 这里曾经握着整套 `LineArtFireVisualRig`（引擎迁移路线图 第 1.5 步的棘轮清单）。
 * 现在**只剩一个数**：目标强度。平滑、顶点重写、火星运动全部搬到了渲染世界的
 * `ThreeFireVisual`，强度经 transform SoA 旁边的参数段过边界。
 *
 * 取值只有 0 与 1，来源两条：快照 `thermal.burning`，以及 spawn 时的静态热源
 * 配置 `HeatEmitterComponent.enabled`。
 */
export class FireVisualComponent extends ActorComponent {
  public constructor(public targetIntensity = 0) {
    super(FIRE_VISUAL_COMPONENT);
  }
}
