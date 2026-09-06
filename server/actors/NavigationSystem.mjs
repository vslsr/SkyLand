import {
  HEALTH_COMPONENT,
  NAVIGATION_COMPONENT,
  PATROL_PATH_COMPONENT,
  TRANSFORM_COMPONENT,
  WEAPON_USER_COMPONENT,
} from '../../shared/actor/index.mjs';
import {
  DEFAULT_NAV_SEARCH_RADIUS_CELLS,
  MAX_NAV_SEARCH_RADIUS_CELLS,
  NavPathfinder,
  smoothNavPath,
  toNavCell,
} from '../../shared/navigation/index.mjs';

/** 一次 tick 最多补的时长。卡顿之后不该让一只生物瞬移过半张地图。 */
const MAXIMUM_CATCH_UP_SECONDS = 0.25;

/**
 * 一 tick 最多做几次 A*。
 *
 * 这是整套寻路唯一一条**跨 Actor** 的成本上限，也是它在大世界里成立的理由：
 * 跟着路走是每只每 tick 几十条算术，搜索是偶尔一次的几百个节点。没有这条闸，
 * 二十只生物同时看见玩家会在同一 tick 里烧掉二十次搜索——房间的 tick 是
 * 16.6 毫秒，那一下就掉帧了。轮转游标保证没有谁会一直排在队尾。
 */
const SEARCHES_PER_TICK = 2;

/**
 * 离最近的玩家超过这么远的生物不寻路。
 *
 * 和 Minecraft 的模拟距离同一个意思：没有人看见的地方，AI 走不走都一样，
 * 而世界大到你永远不可能让所有生物一起想事情。这条闸让整套系统的成本变成
 * 「玩家附近的生物数」，与世界面积无关。
 */
const ACTIVE_RADIUS = 48;

/**
 * 回到岗位算「到了」的距离，米。
 *
 * 它同时是交接那一步位移的上界：交还方向盘时巡逻会把生物挪到路线上离它最近
 * 的那一点，而这个数就是那一挪最多有多远。用一个小常数而不是这只生物自己的
 * `arriveRadius`——后者是「追到多近算够」，那是玩法手感；这一个是「交接许不许
 * 看得见」，那是正确性，不该跟着手感一起被调走。
 */
export const NAVIGATION_HANDOVER_RADIUS = 0.15;

/**
 * 让带 `navigation` 的 Actor 自己找路走。
 *
 * 分工是 Minecraft 那一套：**搜索**（`shared/navigation` 的 A*）偶尔做一次并且
 * 有预算，**跟随**（`NavigationComponent.advance`）每 tick 都做且很便宜。这个
 * System 只负责把两者接起来，外加三件它自己的事：
 *
 * 1. 挑目标——这一版只有一个来源：`chase` 写着就追最近的活玩家。
 * 2. 排队——每 tick 只放 `SEARCHES_PER_TICK` 次搜索过去，轮流来。
 * 3. 落地——把水平位置写回权威 Transform，Y 按精确坐标重新采样地面。
 *
 * 排在 `PatrolPathSystem` **之前**：它决定这只生物这一刻是不是正被导航推着走，
 * 巡逻据此让位。反过来的话，巡逻会在同一 tick 里把刚转向玩家的脸转回路线上。
 */
export class NavigationSystem {
  /**
   * @param {{ searchRadiusCells?: number, searchesPerTick?: number }} [options]
   */
  constructor(options = {}) {
    // 窗口按场景里最大的那只生物开一次。它是这套系统全部的常驻内存，
    // 而且要到第一次真的有人寻路时才分配。
    const requestedRadius = Math.round(Number(options.searchRadiusCells) || 0);
    this.pathfinder = new NavPathfinder({
      radiusCells: Math.min(
        MAX_NAV_SEARCH_RADIUS_CELLS,
        requestedRadius > 0 ? requestedRadius : DEFAULT_NAV_SEARCH_RADIUS_CELLS,
      ),
    });
    this.searchesPerTick = Math.max(1, Math.round(Number(options.searchesPerTick) || SEARCHES_PER_TICK));
    this.activeRadius = Math.max(1, Number(options.activeRadius) || ACTIVE_RADIUS);
    /** 轮转游标：从上一 tick 停下的那一只接着排队。 */
    this.cursor = 0;
    /** 这一 tick 真的做了几次搜索。测试与性能计数用。 */
    this.searchesThisTick = 0;
    this.pose = {
      x: 0, z: 0, yaw: 0, hasHeading: false, moving: false, arrived: false, stuck: false,
    };
    /** 问巡逻「你现在走到哪儿了」时复用的输出对象。 */
    this.patrolPose = { x: 0, y: 0, z: 0, yaw: 0, hasHeading: false, moving: false };
  }

  update(world, deltaSeconds) {
    const step = Math.max(0, Math.min(Number(deltaSeconds) || 0, MAXIMUM_CATCH_UP_SECONDS));
    if (step <= 0) return;
    const navigation = world.context.navigation;
    // 没有接世界就不寻路。测试里的裸 ActorWorld 会走到这里，而不是崩在里面。
    if (!navigation) return;
    const context = navigation.refresh();

    // `query` 返回的是世界自己缓存的数组，按下标读就行，不要复制——这是每 tick
    // 都会走到的一段，一次复制就是一次没有必要的分配。它在一轮 System 之内不会
    // 变：增删都被 `ActorWorld` 排到本轮之后。
    const actors = world.query(NAVIGATION_COMPONENT, TRANSFORM_COMPONENT);
    if (actors.length === 0) return;

    this.searchesThisTick = 0;
    let searchBudget = this.searchesPerTick;
    // 从游标处开始转一圈：预算用完时，下一 tick 从没轮到的那一只接着排。
    const start = this.cursor % actors.length;
    for (let offset = 0; offset < actors.length; offset += 1) {
      const actor = actors[(start + offset) % actors.length];
      const agent = actor.requireComponent(NAVIGATION_COMPONENT);
      const transform = actor.requireComponent(TRANSFORM_COMPONENT);

      // 死了就不走了。尸体留在倒下的那一格，直到 `HealthSystem` 收走它。
      if (actor.getComponent(HEALTH_COMPONENT)?.dead) {
        agent.clearGoal();
        agent.driving = false;
        continue;
      }
      // 正在瞄准的站定不走：和巡逻让位给弓手是同一条规矩，只是这里让位的是
      // 导航。两个系统同时写朝向的话，弓手会永远瞄不准。
      if (actor.getComponent(WEAPON_USER_COMPONENT)?.engaged) {
        agent.clearPath();
        agent.driving = false;
        continue;
      }

      const intent = this.updateIntent(world, actor, agent, transform);
      // 远离所有玩家的生物连队都不排：四十八米外没有人看得见，而这条闸的全部
      // 意义就是不为看不见的地方花钱。
      if (intent === 'idle' || !this.isActive(world, transform)) {
        // 交还方向盘的那一刻把巡逻的进度对齐到它现在站的地方。巡逻的进度在
        // 追击期间是冻结的，不对齐就会有一步瞬移。
        if (agent.driving) actor.getComponent(PATROL_PATH_COMPONENT)?.resyncTo(transform.x, transform.z);
        agent.driving = false;
        agent.tickTimers(step);
        continue;
      }
      // 站定和赶路都算导航在开车：巡逻这段时间一律不许碰这只生物。
      agent.driving = true;
      if (intent === 'hold') {
        agent.clearPath();
        agent.tickTimers(step);
        continue;
      }

      if (searchBudget > 0 && agent.needsRepath(context.revision)) {
        searchBudget -= 1;
        this.searchesThisTick += 1;
        // 游标停在**下一只**上：这一 tick 花掉预算的那只不该在下一 tick 抢在前面。
        this.cursor = (start + offset + 1) % actors.length;
        this.search(context, agent, transform);
      }

      this.follow(world, agent, transform, step);
    }
  }

  /**
   * 这一刻这只生物想干什么。
   *
   * 三个答案：`idle` 把方向盘还给巡逻，`hold` 站定但方向盘留在导航手里，
   * `move` 照着目标走。目标有两个来源，按优先级：`chase` 写着就追最近的活玩家
   * （追出 `giveUpRadius` 放弃），没有人可追时**走回自己的岗位**。别的系统仍然
   * 可以直接调 `agent.setGoal` 推着它走——那时这里只是确认它还有目标。
   *
   * `hold` 与 `idle` 分开是这套交接的关键：追到目标面前站定的那几秒手上没有路，
   * 但方向盘绝不能还回去，否则巡逻会按冻结的进度把它拽回路线上。
   *
   * @returns {'idle' | 'hold' | 'move'}
   */
  updateIntent(world, actor, agent, transform) {
    const players = world.context.players;
    if (!agent.chase || !players) {
      return agent.hasGoal || this.updateHomeGoal(actor, agent, transform) ? 'move' : 'idle';
    }
    let best;
    let bestDistance = Infinity;
    for (const player of players.values()) {
      if (player.getComponent(HEALTH_COMPONENT)?.dead) continue;
      const distance = Math.hypot(player.x - transform.x, player.z - transform.z);
      if (distance >= bestDistance) continue;
      bestDistance = distance;
      best = player;
    }
    // 察觉半径之内才开始追，追出放弃半径才收手。两个数不同是有意的：写成
    // 同一个的话，一个站在边界上的玩家会让它一步一犹豫地抖动。
    const engaged = agent.hasGoal
      ? bestDistance <= agent.chase.giveUpRadius
      : bestDistance <= agent.chase.senseRadius;
    if (!best || !engaged) {
      if (agent.hasGoal) agent.clearGoal();
      return this.updateHomeGoal(actor, agent, transform) ? 'move' : 'idle';
    }
    agent.setGoal(best.x, best.z);
    // 追到 keepDistance 就停：贴身近战写 0，弓手写自己的射程。停下来的是
    // 「不再往前走」，不是「忘了这个人」——目标仍然设着，人一动它就跟上。
    return bestDistance <= Math.max(agent.chase.keepDistance, agent.arriveRadius)
      ? 'hold'
      : 'move';
  }

  /**
   * 没人可追时，走回巡逻线上离开的那一点。
   *
   * 追击期间巡逻是被跳过的（它读 `driving` 让位），所以它的行进进度**冻结**在
   * 生物离开路线的那一刻。直接把方向盘还回去，巡逻会按那个冻结的进度算出一个
   * 位置并写进 Transform——生物于是从追到一半的地方瞬移回路线上。让导航先把它
   * 送回那个点，交接才是连续的：追累了的野兽自己走回岗位，而不是眨眼回到原处。
   *
   * 回不去（比如玩家在它身后砌了墙）时它就停在能到的最近处，`driving` 一直
   * 举着，巡逻也就一直不接管——那看起来是一只被困住的生物，而不是一次瞬移。
   *
   * @returns {boolean} 还需不需要继续走
   */
  updateHomeGoal(actor, agent, transform) {
    const patrol = actor.getComponent(PATROL_PATH_COMPONENT);
    // 出生点是巡逻在第一帧抓的；还没抓到之前无家可归，站着就好。
    if (!patrol?.hasOrigin) return false;
    // 推进 0 秒：只把当前路线位置读出来，不改变任何进度。
    patrol.advance(0, this.patrolPose);
    if (Math.hypot(this.patrolPose.x - transform.x, this.patrolPose.z - transform.z)
      <= NAVIGATION_HANDOVER_RADIUS) {
      if (agent.hasGoal) agent.clearGoal();
      return false;
    }
    agent.setGoal(this.patrolPose.x, this.patrolPose.z);
    return true;
  }

  /** 附近有没有玩家。没有玩家的房间里一只生物都不动——那正是想要的。 */
  isActive(world, transform) {
    const players = world.context.players;
    if (!players) return false;
    const radiusSquared = this.activeRadius * this.activeRadius;
    for (const player of players.values()) {
      const dx = player.x - transform.x;
      const dz = player.z - transform.z;
      if (dx * dx + dz * dz <= radiusSquared) return true;
    }
    return false;
  }

  /** 搜一条路并收下它。找不到通往目标的路时收下的是通往最近点的那一条。 */
  search(context, agent, transform) {
    const result = this.pathfinder.findPath(
      context,
      agent.profile,
      { cellX: toNavCell(transform.x), cellZ: toNavCell(transform.z) },
      { cellX: toNavCell(agent.goalX), cellZ: toNavCell(agent.goalZ) },
    );
    if (result.nodes.length === 0) {
      // 连站的地方都没有（脚下这一格被判成走不通）。清掉路并记一次失败，
      // 由跟随那一层的卡死冷却决定多久之后再试。
      agent.clearPath();
      agent.lastSearchFailed = true;
      agent.repathTimer = agent.repathSeconds;
      return false;
    }
    const smoothed = smoothNavPath(this.pathfinder.region, context, agent.profile, result.nodes);
    // 网格路的最后一个节点是**格心**，而目标未必站在格心上。真的走到了目标格
    // 就补一个精确落点：少了它，跟随永远停在离目标最多一格半径的地方——「走回
    // 岗位」会差那一步而永远交不了班。补的点和格心同格，走过去不会跨任何一条
    // 边，所以不需要再验一次。
    const last = smoothed[smoothed.length - 1];
    if (result.reachedGoal && last && (last.x !== agent.goalX || last.z !== agent.goalZ)) {
      smoothed.push({ ...last, x: agent.goalX, z: agent.goalZ });
    }
    return agent.adoptPath(smoothed, context.revision, result.reachedGoal);
  }

  /** 沿路径走一步，把结果写回权威 Transform。 */
  follow(world, agent, transform, step) {
    const pose = agent.advance(step, transform, this.pose);
    if (!pose.moving && !pose.hasHeading) return;
    // 落地高度按精确的 (x, z) 重新采样，和巡逻走同一条路。路径节点带的 y 是
    // 寻路时的决策高度，拿它当落地高度会让走在斜坡上的生物一跳一跳。
    const groundY = world.context.groundHeightAt?.(pose.x, pose.z);
    transform.setWorldTransform(
      [pose.x, Number.isFinite(groundY) ? groundY : transform.y, pose.z],
      pose.hasHeading ? pose.yaw : transform.yaw,
    );
  }
}
