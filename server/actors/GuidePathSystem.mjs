import {
  GUIDE_PATH_COMPONENT,
  TRANSFORM_COMPONENT,
} from '../../shared/actor/index.mjs';

/** 服务器按玩家权威位置推进配置了 autoAdvance 的共享引导路径。 */
export class GuidePathSystem {
  update(world, deltaSeconds) {
    const players = world.context.players;
    if (!players || players.size === 0) return;
    for (const actor of world.query(GUIDE_PATH_COMPONENT, TRANSFORM_COMPONENT)) {
      const guide = actor.requireComponent(GUIDE_PATH_COMPONENT);
      guide.tickCooldown(deltaSeconds);
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
