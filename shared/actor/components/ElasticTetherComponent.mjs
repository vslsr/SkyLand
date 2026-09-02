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
    /**
     * 叼住之后还要再拉出多远才拔断。0 表示沿用 breakLength 那种「离锚点多远就断」
     * 的绝对判定——而绝对判定的拖拽行程取决于你站多远按的 E：贴脸按能拖一米多，
     * 顶着交互距离按就只剩半米，玩起来像「一按就掉」。
     */
    this.pullDistance = Math.max(0, Number(definition.pullDistance) || 0);
    /** 运行态：叼住那一刻的弹性长度，拔断阈值以它为起点。 */
    this.grabLength = 0;
    this.holderPlayerId = null;
    this.targetX = 0;
    this.targetY = 0;
    this.targetZ = 0;
    this.releaseRevision = 0;
    this.revision = 0;
  }

  /** 本次叼取的拔断长度；没配 pullDistance 时退回绝对 breakLength。 */
  get detachLength() {
    return this.pullDistance > 0 ? this.grabLength + this.pullDistance : this.breakLength;
  }
}
