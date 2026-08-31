import { ActorComponent } from '../ActorComponent.mjs';

export const ELASTIC_TETHER_COMPONENT = 'elastic-tether';

/**
 * 可由玩家端点拉伸、超过长度后自动释放的权威关系。
 * 端点坐标随快照下发；客户端只负责弹性表现，不回写玩法状态。
 */
export class ElasticTetherComponent extends ActorComponent {
  constructor(definition) {
    super(ELASTIC_TETHER_COMPONENT);
    this.restLength = definition.restLength;
    this.breakLength = definition.breakLength;
    this.mouthHeight = definition.mouthHeight;
    this.mouthForwardOffset = definition.mouthForwardOffset;
    this.holderPlayerId = null;
    this.targetX = 0;
    this.targetY = 0;
    this.targetZ = 0;
    this.releaseRevision = 0;
    this.revision = 0;
  }
}
