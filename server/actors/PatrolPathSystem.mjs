import {
  HEALTH_COMPONENT,
  NAVIGATION_COMPONENT,
  PATROL_PATH_COMPONENT,
  TRANSFORM_COMPONENT,
  WEAPON_USER_COMPONENT,
} from '../../shared/actor/index.mjs';

/** 一次 tick 最多补的时长。卡顿之后不该让巡逻者瞬移过半张地图。 */
const MAXIMUM_CATCH_UP_SECONDS = 0.25;

/**
 * 按固定路线推进巡逻 Actor 的权威 Transform。
 *
 * 折线行走的数学在 `PatrolPathComponent` 里，这里只做三件事：第一帧记住出生点、
 * 推进、把结果写回 Transform。位置是权威状态，所以它必须在服务端产生——客户端
 * 只从快照插值，腿的步态再由渲染世界自己从这个位置差分出来。
 *
 * 成本与巡逻 Actor 的数量成正比，而场景常驻 Actor 由 Schema 限制在 256 个以内，
 * 因此它不随流式世界的面积增长。
 */
export class PatrolPathSystem {
  update(world, deltaSeconds) {
    const step = Math.max(0, Math.min(Number(deltaSeconds) || 0, MAXIMUM_CATCH_UP_SECONDS));
    if (step <= 0) return;
    const pose = { x: 0, y: 0, z: 0, yaw: 0, hasHeading: false, moving: false };
    for (const actor of world.query(PATROL_PATH_COMPONENT, TRANSFORM_COMPONENT)) {
      // 死了就不走了。尸体留在倒下的那一格，直到 `HealthSystem` 收走它。
      if (actor.getComponent(HEALTH_COMPONENT)?.dead) continue;
      // 正在瞄准的站定不走（`WeaponUserSystem` 在这之前刚写下这个标记）。两个
      // 系统同时写朝向的话，一个把脸转向目标、另一个把脸转回路线，弓手会永远
      // 瞄不准——那不是「难打」，是打不出去。
      if (actor.getComponent(WEAPON_USER_COMPONENT)?.engaged) continue;
      // 正被导航推着走的也一样让位（`NavigationSystem` 在这之前刚写下这个标记）。
      // 一只追着玩家跑的生物如果同时还被巡逻拽回路线上，它会原地画圈。追完了
      // 导航自己会把标记放下，巡逻从当前段接着走——路线是相对出生点解算的，
      // 中途被带偏也不会让整条线跟着漂。
      if (actor.getComponent(NAVIGATION_COMPONENT)?.driving) continue;
      const patrol = actor.requireComponent(PATROL_PATH_COMPONENT);
      const transform = actor.requireComponent(TRANSFORM_COMPONENT);
      // 出生点只抓一次：路线相对它解算，而 Actor 自己正被这条路线推着走。
      if (!patrol.hasOrigin) patrol.captureOrigin(transform);
      patrol.advance(step, pose);
      const groundY = world.context.groundHeightAt?.(pose.x, pose.z);
      transform.setWorldTransform(
        [pose.x, Number.isFinite(groundY) ? groundY : pose.y, pose.z],
        pose.hasHeading ? pose.yaw : transform.yaw,
      );
    }
  }
}
