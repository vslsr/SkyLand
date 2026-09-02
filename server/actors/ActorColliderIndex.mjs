import {
  PICKUP_DROP_COMPONENT,
  SIMPLE_COLLISION_COMPONENT,
  TRANSFORM_COMPONENT,
} from '../../shared/actor/index.mjs';
import { COLLISION_LAYER_SOLID } from '../../shared/collision/index.mjs';
import { simpleCollisionInstanceToPhysicsDefinitions } from '../../shared/physics/simpleCollisionToPhysics.mjs';

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
    const physics = world.context?.physics;
    if (!collision && !physics) return;
    this.live.clear();
    for (const actor of world.query(TRANSFORM_COMPONENT, SIMPLE_COLLISION_COMPONENT)) {
      // 叼在嘴上的东西不占地方：它的碰撞盒就挂在玩家正前方，登记进去等于让玩家
      // 顶着自己嘴里那一个走不动。不进 live，下面的回收循环会把它撤掉。
      if (actor.parent?.getComponent(PICKUP_DROP_COMPONENT)?.heldActorId === actor.id) continue;
      this.live.add(actor.id);
      let instance = this.instances.get(actor.id);
      if (!instance || instance.actor !== actor) {
        instance = {
          collision: actor.requireComponent(SIMPLE_COLLISION_COMPONENT),
          transform: actor.requireComponent(TRANSFORM_COMPONENT),
          layers: COLLISION_LAYER_SOLID,
          // 推出时要能认出「这是谁」，船才不会被自己或自己的货推走。
          actor,
          publishedX: Number.NaN,
          publishedY: Number.NaN,
          publishedZ: Number.NaN,
          publishedYaw: Number.NaN,
        };
        this.instances.set(actor.id, instance);
      }
      const transform = instance.transform;
      if (
        transform.x !== instance.publishedX
        || transform.y !== instance.publishedY
        || transform.z !== instance.publishedZ
        || transform.yaw !== instance.publishedYaw
      ) {
        collision?.setDynamic(actor.id, instance);
        const definitions = simpleCollisionInstanceToPhysicsDefinitions(instance);
        if (definitions.length > 0 && !physics?.hasDynamicActor(actor.id)) {
          physics?.setActorCollider(actor.id, definitions);
        }
        instance.publishedX = transform.x;
        instance.publishedY = transform.y;
        instance.publishedZ = transform.z;
        instance.publishedYaw = transform.yaw;
      }
    }
    for (const actorId of Array.from(this.instances.keys())) {
      if (this.live.has(actorId)) continue;
      this.instances.delete(actorId);
      collision?.removeDynamic(actorId);
      physics?.removeActorCollider(actorId);
      physics?.removeDynamicActor(actorId);
    }
  }
}
