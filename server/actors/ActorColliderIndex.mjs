import {
  SIMPLE_COLLISION_COMPONENT,
  TRANSFORM_COMPONENT,
} from '../../shared/actor/index.mjs';
import { COLLISION_LAYER_SOLID } from '../../shared/collision/index.mjs';

/**
 * 把 ActorWorld 里的碰撞盒同步进场景的空间划分。
 *
 * 它既是一个 ActorWorld System，也可以被直接调用。之所以在一个 tick 里跑
 * 两次：Actor 移动之后、推出解算之前要有一次，让宽相拿到的是这一 tick 的
 * 位置；tick 末尾还要有一次，因为玩家输入是在两个 tick 之间结算的，那时
 * 查询到的必须是最新位置。
 *
 * 成本随房间里的 Actor 数（上限 256）走，不随世界面积走。Actor 每帧只挪动
 * 一点点，网格多半只是原地改数值，不做任何 Map 操作。
 */
export class ActorColliderIndex {
  constructor() {
    /** @type {Map<string, object>} actorId → 登记进碰撞世界的实例，逐帧复用。 */
    this.instances = new Map();
    this.live = new Set();
  }

  update(world) {
    const collision = world.context?.collision;
    if (!collision) return;
    this.live.clear();
    for (const actor of world.query(TRANSFORM_COMPONENT, SIMPLE_COLLISION_COMPONENT)) {
      this.live.add(actor.id);
      let instance = this.instances.get(actor.id);
      if (!instance) {
        instance = {
          collision: actor.requireComponent(SIMPLE_COLLISION_COMPONENT),
          transform: actor.requireComponent(TRANSFORM_COMPONENT),
          layers: COLLISION_LAYER_SOLID,
          // 推出时要能认出「这是谁」，船才不会被自己或自己的货推走。
          actor,
        };
        this.instances.set(actor.id, instance);
      }
      collision.setDynamic(actor.id, instance);
    }
    for (const actorId of Array.from(this.instances.keys())) {
      if (this.live.has(actorId)) continue;
      this.instances.delete(actorId);
      collision.removeDynamic(actorId);
    }
  }
}
