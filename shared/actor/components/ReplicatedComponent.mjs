import { ActorComponent } from '../ActorComponent.mjs';

export const REPLICATED_COMPONENT = 'replicated';

/** 服务端快照资格标记。没有该 Component 的 Actor 完全不进入快照遍历。 */
export class ReplicatedComponent extends ActorComponent {
  constructor() {
    super(REPLICATED_COMPONENT);
  }
}
