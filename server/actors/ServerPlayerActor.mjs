import {
  Actor,
  InventoryComponent,
  PLAYER_MOVEMENT_COMPONENT,
  PlayerMovementComponent,
  TRANSFORM_COMPONENT,
  TransformComponent,
} from '../../shared/actor/index.mjs';
import { INPUT_TIME_BUDGET_SECONDS } from '../../shared/networkTuning.mjs';

/**
 * 按连接动态创建的玩家 Actor。玩家不属于场景固定 placements；其高频位置仍走
 * players 快照，以保留本地预测与和解协议。
 */
export class ServerPlayerActor extends Actor {
  constructor(player, archetype, spawn, now) {
    super(player.id, archetype.id);
    this.name = player.name;
    this.addComponent(new TransformComponent({ position: [spawn.x, 0, spawn.z], yaw: Math.PI }));
    this.addComponent(new PlayerMovementComponent(archetype.components.playerMovement));
    this.addComponent(new InventoryComponent());
    this.collisionRadius = archetype.components.render.radius;
    this.collisionHeight = this.collisionRadius * 2;
    this.speed = 0;
    this.sequence = 0;
    this.actorInteractionSequence = 0;
    this.timeBudget = INPUT_TIME_BUDGET_SECONDS;
    this.lastInputAt = now;
    // ServerScene.players 过去保存普通对象；保留可枚举坐标，兼容监控/测试里
    // 通过对象展开记录一帧位置的用法，同时实际数据仍由 Transform Component 持有。
    Object.defineProperties(this, {
      x: { enumerable: true, get: () => this.transform.x, set: (value) => this.setPosition(value, this.z) },
      y: { enumerable: true, get: () => this.transform.y },
      z: { enumerable: true, get: () => this.transform.z, set: (value) => this.setPosition(this.x, value) },
      yaw: {
        enumerable: true,
        get: () => this.transform.yaw,
        set: (value) => this.transform.setWorldTransform([this.x, this.y, this.z], value),
      },
    });
  }

  get movement() {
    return this.requireComponent(PLAYER_MOVEMENT_COMPONENT);
  }

  get transform() {
    return this.requireComponent(TRANSFORM_COMPONENT);
  }

  get x() { return this.transform.x; }
  set x(value) { this.setPosition(value, this.z); }
  get y() { return this.transform.y; }
  get z() { return this.transform.z; }
  set z(value) { this.setPosition(this.x, value); }
  get yaw() { return this.transform.yaw; }
  set yaw(value) {
    this.transform.setWorldTransform([this.x, this.y, this.z], value);
  }

  setPosition(x, z) {
    this.transform.setWorldTransform([x, this.y, z], this.yaw);
  }
}
