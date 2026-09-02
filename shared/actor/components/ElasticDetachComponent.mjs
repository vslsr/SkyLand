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

  /** 脱离事件：拔断方向交给监听者，用于表现或玩法反馈。 */
  pop(direction) {
    if (!this.markDetached()) return undefined;
    const event = { direction };
    for (const listener of this.poppedListeners) listener(event);
    return event;
  }
}
