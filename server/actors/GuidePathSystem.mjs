import {
  GUIDE_PATH_COMPONENT,
  TRANSFORM_COMPONENT,
} from '../../shared/actor/index.mjs';

const SIMULATION_STEP_SECONDS = 0.1;
const MAXIMUM_CATCH_UP_SECONDS = 0.3;

/**
 * 服务器按玩家权威位置推进配置了 autoAdvance 的共享引导路径。
 * 固定 10 Hz 检查；场景常驻 Actor 又由 Schema 限制为最多 256 个，因此成本不随
 * 流式世界面积或渲染帧率增长。客户端复制另由 replicationPolicy AOI 限制。
 */
export class GuidePathSystem {
  constructor() {
    this.accumulator = 0;
  }

  update(world, deltaSeconds) {
    const players = world.context.players;
    if (!players || players.size === 0) {
      this.accumulator = 0;
      return;
    }
    const safeDelta = Math.max(0, Math.min(Number(deltaSeconds) || 0, MAXIMUM_CATCH_UP_SECONDS));
    this.accumulator = Math.min(this.accumulator + safeDelta, MAXIMUM_CATCH_UP_SECONDS);
    while (this.accumulator + Number.EPSILON >= SIMULATION_STEP_SECONDS) {
      this.accumulator -= SIMULATION_STEP_SECONDS;
      this.simulateStep(world, players);
    }
  }

  simulateStep(world, players) {
    for (const actor of world.query(GUIDE_PATH_COMPONENT, TRANSFORM_COMPONENT)) {
      const guide = actor.requireComponent(GUIDE_PATH_COMPONENT);
      guide.tickCooldown(SIMULATION_STEP_SECONDS);
      if (!guide.enabled || !guide.autoAdvance || guide.hitCooldown > 0) continue;
      if (guide.complete) {
        if (guide.loop) guide.reset();
        else continue;
      }
      const transform = actor.requireComponent(TRANSFORM_COMPONENT);
      const point = guide.points[guide.currentPointIndex];
      const cosYaw = Math.cos(transform.yaw);
      const sinYaw = Math.sin(transform.yaw);
      const worldX = transform.x + cosYaw * point[0] + sinYaw * point[2];
      const worldZ = transform.z - sinYaw * point[0] + cosYaw * point[2];
      const hitRadiusSq = guide.hitRadius * guide.hitRadius;
      for (const player of players.values()) {
        const deltaX = player.x - worldX;
        const deltaZ = player.z - worldZ;
        if (deltaX * deltaX + deltaZ * deltaZ <= hitRadiusSq) {
          guide.advance();
          break;
        }
      }
    }
  }
}
