import { createNavProfile } from '../../navigation/NavProfile.mjs';
import { ActorComponent } from '../ActorComponent.mjs';

export const NAVIGATION_COMPONENT = 'navigation';

/** 一次推进最多补的时长。卡顿之后不该让一只生物瞬移过半张地图。 */
const MAXIMUM_CATCH_UP_SECONDS = 0.25;
/** 连续这么久没走出多少距离就算卡住了。 */
const STUCK_WINDOW_SECONDS = 0.75;
/** 卡住的判据：这段时间里走过的距离不到「本该走的」这么多比例。 */
const STUCK_PROGRESS_RATIO = 0.25;

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * 会自己找路的单位。
 *
 * 对应 Minecraft 的 `PathNavigation`：**持有一条路、沿着它走、判断什么时候
 * 该重想一条**。真正的搜索不在这里——那是 `shared/navigation` 那一层的事，
 * 由 `NavigationSystem` 在预算之内调用。分开的理由是两者的成本完全不同：
 * 跟着路走是每 tick 每只都要做的几十条算术，搜索是偶尔一次的几百个节点。
 * 混在一起写，就没有办法只给后者上预算。
 *
 * 推进逻辑放在 Component 而不是 System，和 `PatrolPathComponent` 同一个理由：
 * 它是一段纯粹的折线行走数学，不需要 ActorWorld 就能单测。
 *
 * **目标从哪来**：这一版只有一个目标来源——`chase` 写着的话就追最近的玩家。
 * 这是边界，写在这里而不是散在判断里。AI 追 AI 要的是阵营，而阵营现在还不
 * 存在，先做出来会是一个没有人用的猜测。没写 `chase` 的单位仍然可以由别的
 * 系统调 `setGoal` 推着走。
 */
export class NavigationComponent extends ActorComponent {
  constructor(definition = {}) {
    super(NAVIGATION_COMPONENT);
    /** 沿路径行走的速度，米每秒。 */
    this.speed = Math.max(0.01, finiteOr(definition.speed, 1.6));
    /** 转身速度，弧度每秒。转身慢的单位过拐角会画出一道弧。 */
    this.turnSpeed = Math.max(0.01, finiteOr(definition.turnSpeed, 6));
    /** 走到离节点这么近就算过了这一个节点，米。 */
    this.nodeRadius = Math.max(0.05, finiteOr(definition.nodeRadius, 0.45));
    /**
     * 离目标这么近就算到了，米。
     *
     * 必须大于 `nodeRadius`：跟随是走到「离最后一个节点不到 nodeRadius」就停手的，
     * 到不了比这更近的地方。两者写反的话，一只已经站在目标上的生物会永远认为
     * 自己还没到。
     */
    this.arriveRadius = Math.max(this.nodeRadius * 1.5, finiteOr(definition.arriveRadius, 1.2));
    /** 隔多久重想一次路，秒。世界会变，一条五秒前的路未必还成立。 */
    this.repathSeconds = Math.max(0.1, finiteOr(definition.repathSeconds, 1.2));
    /** 目标挪出这么远就立刻重想，米。追人时这一条比定时那一条先触发。 */
    this.goalTolerance = Math.max(0.1, finiteOr(definition.goalTolerance, 1.5));
    /**
     * 追击参数。写了才追人；不写的话这只单位只在别人调 `setGoal` 时才动。
     * @type {{ senseRadius: number, giveUpRadius: number, keepDistance: number } | undefined}
     */
    this.chase = definition.chase
      ? {
        senseRadius: Math.max(0.5, finiteOr(definition.chase.senseRadius, 12)),
        // 咬住之后的放弃距离要比察觉距离大，否则目标站在边界上会让它一步一
        // 犹豫地抖动。
        giveUpRadius: Math.max(
          Math.max(0.5, finiteOr(definition.chase.senseRadius, 12)) + 0.5,
          finiteOr(definition.chase.giveUpRadius, 18),
        ),
        /** 追到这么近就停下来。近战贴身写 0，弓手写自己的射程。 */
        keepDistance: Math.max(0, finiteOr(definition.chase.keepDistance, 1.2)),
      }
      : undefined;

    /** 体型与代价表。搜索的每一层都要它，所以只解析一次。 */
    this.profile = createNavProfile(definition);

    /** @type {import('../../navigation/NavPathfinder.mjs').NavPathNode[]} */
    this.path = [];
    /** 下一个要走到的节点下标。 */
    this.pathIndex = 0;
    this.hasGoal = false;
    this.goalX = 0;
    this.goalZ = 0;
    /** 这条路是照着哪个目标算的。目标挪远了就该重想。 */
    this.pathGoalX = 0;
    this.pathGoalZ = 0;
    /** 算这条路时世界的版本号。有人盖了墙就作废。 */
    this.pathRevision = -1;
    this.repathTimer = 0;
    /**
     * 这一刻是不是正被导航推着走。巡逻系统据此让位。
     *
     * **由 System 写，不由这里写**：让位的边界比「手上有没有路」宽——追到目标
     * 面前站定的那几秒、走回岗位的那一段，手上都可能没有路，但方向盘仍然在
     * 导航手里。混在一起的话，巡逻会在那几秒里按自己冻结的进度把生物拽回
     * 路线上，玩家看到的是一次瞬移。
     */
    this.driving = false;
    /** 上一次搜索没找到通往目标的路。它决定这一次要不要早点再试。 */
    this.lastSearchFailed = false;

    this.stuckTimer = 0;
    this.stuckReferenceX = 0;
    this.stuckReferenceZ = 0;
    this.hasStuckReference = false;
    /** 走不动的次数。连着卡住就先歇一会儿，别每 tick 都去烧一次搜索预算。 */
    this.stuckStrikes = 0;
    this.cooldownSeconds = 0;
  }

  /** 设一个世界坐标的目标。目标没挪就什么都不做，免得每 tick 都清掉进度。 */
  setGoal(x, z) {
    const goalX = finiteOr(x, this.goalX);
    const goalZ = finiteOr(z, this.goalZ);
    if (this.hasGoal && Math.hypot(goalX - this.goalX, goalZ - this.goalZ) < 1e-6) return false;
    this.hasGoal = true;
    this.goalX = goalX;
    this.goalZ = goalZ;
    return true;
  }

  clearGoal() {
    this.hasGoal = false;
    this.clearPath();
  }

  clearPath() {
    this.path.length = 0;
    this.pathIndex = 0;
    this.hasStuckReference = false;
    this.stuckTimer = 0;
  }

  /**
   * 收下一条刚算好的路。
   *
   * 起点格就是这只生物脚下那一格，走过去毫无意义，所以路径从第 1 个节点开始
   * 跟。只有一个节点的路（原地）等于没有路。
   */
  adoptPath(nodes, revision, reachedGoal) {
    this.path = Array.isArray(nodes) ? nodes : [];
    this.pathIndex = this.path.length > 1 ? 1 : 0;
    this.pathRevision = revision;
    this.pathGoalX = this.goalX;
    this.pathGoalZ = this.goalZ;
    this.repathTimer = this.repathSeconds;
    this.lastSearchFailed = !reachedGoal;
    this.hasStuckReference = false;
    this.stuckTimer = 0;
    return this.hasPath;
  }

  get hasPath() {
    return this.path.length > 1 && this.pathIndex < this.path.length;
  }

  /** 还没走的那一段有多长，米。跟随那一层用它判断「快走完了，先想下一条」。 */
  remainingDistance(fromX, fromZ) {
    if (!this.hasPath) return 0;
    let total = 0;
    let previousX = fromX;
    let previousZ = fromZ;
    for (let index = this.pathIndex; index < this.path.length; index += 1) {
      total += Math.hypot(this.path[index].x - previousX, this.path[index].z - previousZ);
      previousX = this.path[index].x;
      previousZ = this.path[index].z;
    }
    return total;
  }

  /**
   * 这一刻要不要重新搜一条路。
   *
   * 四条理由，任何一条成立都要重想：没有路、世界改了（有人盖了墙）、目标挪远了、
   * 定时到了。世界那一条是建造系统接进来的入口——玩家在生物面前放下一堵墙，
   * 它手上那条穿墙而过的路必须当场作废，而不是等下一个周期。
   */
  needsRepath(revision) {
    if (!this.hasGoal) return false;
    if (this.cooldownSeconds > 0) return false;
    if (!this.hasPath) return true;
    if (this.pathRevision !== revision) return true;
    if (Math.hypot(this.goalX - this.pathGoalX, this.goalZ - this.pathGoalZ) > this.goalTolerance) {
      return true;
    }
    return this.repathTimer <= 0;
  }

  /**
   * 只走时钟，不走路。
   *
   * 没有目标、正在瞄准、离所有玩家都很远的那些 tick 里，这只生物不该被推着走，
   * 但它的重寻路计时和卡死冷却仍然要过去——否则一只卡住之后失去目标的生物会
   * 带着一个永远不减的冷却，下次遇到玩家时先干站一秒半。
   */
  tickTimers(deltaSeconds) {
    const step = Math.max(0, Math.min(finiteOr(deltaSeconds, 0), MAXIMUM_CATCH_UP_SECONDS));
    this.cooldownSeconds = Math.max(0, this.cooldownSeconds - step);
    this.repathTimer = Math.max(0, this.repathTimer - step);
    return step;
  }

  /**
   * 沿路径推进 `deltaSeconds`，把这一刻的位置与朝向写进 `out`。
   *
   * 只走水平：落地高度由调用方按精确的 (x, z) 采样地面，和巡逻同一条路。
   * 路径节点带的 `y` 是寻路时的决策高度，拿它当落地高度会让走在斜坡上的
   * 生物按格心高度一跳一跳。
   *
   * @param {number} deltaSeconds
   * @param {{ x: number, z: number, yaw: number }} from 当前权威 Transform
   * @param {{ x: number, z: number, yaw: number, hasHeading: boolean, moving: boolean,
   *   arrived: boolean, stuck: boolean }} out
   */
  advance(deltaSeconds, from, out) {
    const step = this.tickTimers(deltaSeconds);
    out.x = from.x;
    out.z = from.z;
    out.yaw = from.yaw;
    out.hasHeading = false;
    out.moving = false;
    out.arrived = false;
    out.stuck = false;
    if (!this.hasPath || step <= 0) return out;

    // 先跳过已经走到的节点。一次 tick 走过好几个短节点是常事（平滑之后节点稀疏，
    // 但转角处仍然可能挨得很近）。
    let budget = this.speed * step;
    let currentX = from.x;
    let currentZ = from.z;
    let headingX = 0;
    let headingZ = 0;
    let guard = this.path.length + 1;
    while (this.pathIndex < this.path.length && budget > 0 && guard > 0) {
      guard -= 1;
      const node = this.path[this.pathIndex];
      const toX = node.x - currentX;
      const toZ = node.z - currentZ;
      const distance = Math.hypot(toX, toZ);
      // 中间节点擦着过就算过了——那点余量正是拐角看起来圆滑的原因。**最后一个
      // 节点不一样**：它是精确落点，要真的走上去。拿同一个余量对付它，生物会
      // 停在离目标一个 nodeRadius 的地方，而「到底算不算到了」的判断就全落在
      // 那圈说不清的余量里。
      const tolerance = this.pathIndex === this.path.length - 1
        ? 1e-3
        : Math.max(this.nodeRadius, 1e-6);
      if (distance <= tolerance) {
        this.pathIndex += 1;
        continue;
      }
      headingX = toX / distance;
      headingZ = toZ / distance;
      const travel = Math.min(budget, distance);
      currentX += headingX * travel;
      currentZ += headingZ * travel;
      budget -= travel;
      if (travel >= distance - 1e-9) this.pathIndex += 1;
    }

    const moved = Math.hypot(currentX - from.x, currentZ - from.z);
    out.x = currentX;
    out.z = currentZ;
    out.moving = moved > 1e-6;
    if (headingX !== 0 || headingZ !== 0) {
      out.hasHeading = true;
      out.yaw = this.turnTowardYaw(from.yaw, Math.atan2(headingX, headingZ), this.turnSpeed * step);
    }
    if (this.pathIndex >= this.path.length) {
      out.arrived = true;
      this.clearPath();
    }
    out.stuck = this.trackProgress(step, currentX, currentZ);
    return out;
  }

  /**
   * 卡住检测。
   *
   * 判据是「这段时间里实际走过的直线距离，够不够本该走的四分之一」。用直线
   * 位移而不是累计路程：一只顶着树打转的生物累计路程很可观，直线位移却接近零，
   * 而后者才是玩家看到的「它卡住了」。
   *
   * @returns {boolean} 这一刻是不是刚判定为卡住
   */
  trackProgress(step, x, z) {
    if (!this.hasStuckReference) {
      this.hasStuckReference = true;
      this.stuckReferenceX = x;
      this.stuckReferenceZ = z;
      this.stuckTimer = 0;
      return false;
    }
    this.stuckTimer += step;
    if (this.stuckTimer < STUCK_WINDOW_SECONDS) return false;
    const progressed = Math.hypot(x - this.stuckReferenceX, z - this.stuckReferenceZ);
    const expected = this.speed * this.stuckTimer;
    this.stuckTimer = 0;
    this.stuckReferenceX = x;
    this.stuckReferenceZ = z;
    if (progressed >= expected * STUCK_PROGRESS_RATIO) {
      this.stuckStrikes = 0;
      return false;
    }
    this.stuckStrikes += 1;
    this.clearPath();
    // 连着卡住就歇一会儿再想。每 tick 重搜一次只会把预算烧在同一条死路上，
    // 而玩家看到的仍然是一只贴着墙抖的生物。
    if (this.stuckStrikes >= 3) this.cooldownSeconds = 1.5;
    return true;
  }

  /** 朝目标转一步，返回转过之后的朝向。 */
  turnTowardYaw(currentYaw, desiredYaw, maximumStep) {
    let delta = desiredYaw - currentYaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    return currentYaw + Math.max(-maximumStep, Math.min(maximumStep, delta));
  }
}
