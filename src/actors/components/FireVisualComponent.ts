import { ActorComponent } from '../../../shared/actor/ActorComponent.mjs';
import type { LineArtFireVisualRig } from '../../models/actors/ActorVisualModel';

export const FIRE_VISUAL_COMPONENT = 'fire-visual';

/** 客户端本地表现状态；目标强度来自服务端快照或静态热源配置。 */
export class FireVisualComponent extends ActorComponent {
  public intensity: number;
  public targetIntensity: number;

  public constructor(
    public readonly rig: LineArtFireVisualRig,
    initialIntensity = 0,
  ) {
    super(FIRE_VISUAL_COMPONENT);
    this.intensity = initialIntensity;
    this.targetIntensity = initialIntensity;
  }
}
