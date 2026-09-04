import { ActorComponent } from '../../../shared/actor/ActorComponent.mjs';

export const POINT_LIGHT_COMPONENT = 'point-light';

/**
 * 玩法侧的「这盏灯亮不亮」。
 *
 * 和 `FireVisualComponent` 一样，Actor 身上只剩**一个数**：目标强度。颜色、
 * 半径、闪烁与衰减全在渲染世界里（`ThreePointLightVisual`），灯的样子是渲染侧
 * 的决定，开关才是玩法侧的事实。
 *
 * 取值只有 0 与 1，来源两条：会烧的东西跟着火走（快照 `thermal.burning`
 * 或静态热源配置），不会烧的东西用原型里 `pointLight.enabled` 那个静态开关。
 */
export class PointLightComponent extends ActorComponent {
  public constructor(public targetIntensity = 0) {
    super(POINT_LIGHT_COMPONENT);
  }
}
