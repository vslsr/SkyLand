import { ActorComponent } from '../ActorComponent.mjs';

export const ELASTIC_DETACH_COMPONENT = 'elasticDetach';

/** 拉伸断裂后从锚点脱离；运动参数由同 Actor 的 DropMotionComponent 提供。 */
export class ElasticDetachComponent extends ActorComponent {
  constructor(definition = {}) {
    super(ELASTIC_DETACH_COMPONENT);
    this.detached = definition.detached === true;
    /** 本地运行态：掉落碰撞是否已经替换，既不持久化也不复制。 */
    this.dropCollisionApplied = false;
    this.revision = 0;
    this.poppedListeners = new Set();
  }

  markDetached() {
    if (this.detached) return false;
    this.detached = true;
    this.revision += 1;
    return true;
  }

  onPopped(listener) {
    this.poppedListeners.add(listener);
    return () => this.poppedListeners.delete(listener);
  }

  /**
   * 脱离时把线冲量和角冲量都交给监听者填。角冲量不是装饰：掉在地上的物件
   * 只有真的翻起来才会躺着，光靠水平位移换算出的滚动角远远不够。
   */
  pop(direction) {
    if (!this.markDetached()) return undefined;
    const event = {
      direction,
      impulse: { x: 0, y: 0, z: 0 },
      torqueImpulse: { x: 0, y: 0, z: 0 },
    };
    for (const listener of this.poppedListeners) listener(event);
    return event;
  }
}
