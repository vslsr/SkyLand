import { ActorComponent } from '../ActorComponent.mjs';

export const PATROL_PATH_COMPONENT = 'patrol-path';
export const MAX_PATROL_WAYPOINTS = 16;
export const MAX_PATROL_LOCAL_COORDINATE = 64;

/** 走到尽头掉头（来回），还是绕回起点（环线）。 */
const MODES = new Set(['ping-pong', 'loop']);

function finiteOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function copyWaypoints(waypoints) {
  if (!Array.isArray(waypoints) || waypoints.length < 2) {
    throw new TypeError('PatrolPath 至少需要 2 个路点');
  }
  if (waypoints.length > MAX_PATROL_WAYPOINTS) {
    throw new TypeError(`PatrolPath 最多 ${MAX_PATROL_WAYPOINTS} 个路点`);
  }
  return waypoints.map((point) => {
    if (!Array.isArray(point) || point.length !== 3) {
      throw new TypeError('PatrolPath 路点必须是 [x, y, z]');
    }
    return point.map((value) => {
      const number = finiteOr(value, NaN);
      if (!Number.isFinite(number) || Math.abs(number) > MAX_PATROL_LOCAL_COORDINATE) {
        throw new TypeError('PatrolPath 路点坐标超出范围');
      }
      return number;
    });
  });
}

/**
 * 服务器权威的固定巡逻路线。
 *
 * **路点在 Actor 的局部空间**，和 `GuidePathComponent` 同一个约定：原型描述的是
 * 「这条路线长什么样」，场景放置决定它落在世界的哪里、朝哪个方向。同一个原型摆
 * 两份就是两条平行的巡逻线，不需要为每个位置各写一个原型。
 *
 * 起点由 System 在第一帧从 Transform 抓取并**记住**。不能每帧拿当前 Transform
 * 当原点——Actor 自己正被这条路线推着走，那样路线会跟着它一起漂走。
 *
 * 推进逻辑放在 Component 而不是 System：它是一段纯粹的折线行走数学，不需要
 * ActorWorld 就能单测。System 只负责抓原点、调用它、把结果写回 Transform。
 */
export class PatrolPathComponent extends ActorComponent {
  constructor(definition = {}) {
    super(PATROL_PATH_COMPONENT);
    this.waypoints = copyWaypoints(definition.waypoints);
    this.speed = Math.max(0, finiteOr(definition.speed, 1));
    this.waitSeconds = Math.max(0, finiteOr(definition.waitSeconds, 0));
    const mode = definition.mode ?? 'ping-pong';
    if (!MODES.has(mode)) throw new TypeError('PatrolPath mode 必须是 ping-pong 或 loop');
    this.mode = mode;

    /** 当前所在段的起点下标。 */
    this.segmentIndex = 0;
    /** 沿当前段走了多少，0..1。 */
    this.segmentProgress = 0;
    /** ping-pong 的行进方向：+1 往后走，-1 往回走。 */
    this.direction = 1;
    this.waitRemaining = 0;

    this.hasOrigin = false;
    this.originX = 0;
    this.originY = 0;
    this.originZ = 0;
    this.originYaw = 0;
  }

  /** 记住出生位置。路线的所有坐标都相对它解算，之后 Actor 怎么走都不影响它。 */
  captureOrigin(transform) {
    this.originX = transform.x;
    this.originY = transform.y;
    this.originZ = transform.z;
    this.originYaw = transform.yaw;
    this.hasOrigin = true;
    return this;
  }

  /** 把第 `index` 个局部路点解算成世界坐标，写进调用方自带的对象，不分配。 */
  resolveWaypoint(index, out) {
    const point = this.waypoints[index];
    const sinYaw = Math.sin(this.originYaw);
    const cosYaw = Math.cos(this.originYaw);
    out.x = this.originX + cosYaw * point[0] + sinYaw * point[2];
    out.y = this.originY + point[1];
    out.z = this.originZ - sinYaw * point[0] + cosYaw * point[2];
    return out;
  }

  /** 沿行进方向的下一个路点；到头时按 mode 掉头或绕回，并返回新的方向。 */
  nextIndex(index, direction) {
    const count = this.waypoints.length;
    if (this.mode === 'loop') {
      return { index: (index + 1) % count, direction: 1 };
    }
    const candidate = index + direction;
    if (candidate >= 0 && candidate < count) return { index: candidate, direction };
    const flipped = -direction;
    return { index: index + flipped, direction: flipped };
  }

  /**
   * 把行进进度对齐到某个世界位置上。
   *
   * 用在**交还方向盘**的那一刻：追击期间巡逻是被跳过的，它的进度冻结在生物
   * 离开路线时；直接恢复的话，巡逻算出来的第一个位置未必就是生物现在站的
   * 地方，那一步会成为一次瞬移。把进度挪到离当前位置最近的那一点上，交接
   * 就是连续的。
   *
   * 段的枚举**从当前段开始**，并且只有严格更近的段才顶掉它。来回走的路线上
   * 一条线会被正反各数一次，两次投影一样近；不给当前段这个优先权的话，一只
   * 正在回程的生物会因为并列而忽然掉头。行进方向本身不动——它由
   * `nextIndex(segmentIndex, direction)` 决定，这里改的只是走到哪儿了。
   */
  resyncTo(x, z) {
    if (!this.hasOrigin) return false;
    const from = { x: 0, y: 0, z: 0 };
    const to = { x: 0, y: 0, z: 0 };
    const count = this.waypoints.length;
    let bestIndex = this.segmentIndex;
    let bestProgress = this.segmentProgress;
    let bestDistance = Infinity;
    for (let offset = 0; offset < count; offset += 1) {
      const index = (this.segmentIndex + offset) % count;
      const step = this.nextIndex(index, this.direction);
      if (step.index === index) continue;
      this.resolveWaypoint(index, from);
      this.resolveWaypoint(step.index, to);
      const deltaX = to.x - from.x;
      const deltaZ = to.z - from.z;
      const lengthSquared = deltaX * deltaX + deltaZ * deltaZ;
      if (lengthSquared <= 1e-12) continue;
      const projected = Math.max(0, Math.min(
        1,
        ((x - from.x) * deltaX + (z - from.z) * deltaZ) / lengthSquared,
      ));
      const closestX = from.x + deltaX * projected;
      const closestZ = from.z + deltaZ * projected;
      const distance = Math.hypot(x - closestX, z - closestZ);
      if (distance >= bestDistance) continue;
      bestDistance = distance;
      bestIndex = index;
      bestProgress = projected;
    }
    if (bestDistance === Infinity) return false;
    this.segmentIndex = bestIndex;
    this.segmentProgress = bestProgress;
    // 站定过的生物不该在交接的同时又被一个残留的到站停顿钉住。
    this.waitRemaining = 0;
    return true;
  }

  /**
   * 推进 `deltaSeconds`，把当前位置与朝向写进 `out`。
   *
   * 一次调用可能跨过多个路点（低帧率或短路段），所以里面是个循环；循环次数按
   * 路点数封顶，一条所有路点都重合的退化路线不会把 tick 卡死。
   */
  advance(deltaSeconds, out) {
    const from = { x: 0, y: 0, z: 0 };
    const to = { x: 0, y: 0, z: 0 };
    let remaining = Math.max(0, deltaSeconds);

    if (this.waitRemaining > 0) {
      const consumed = Math.min(this.waitRemaining, remaining);
      this.waitRemaining -= consumed;
      remaining -= consumed;
    }

    let distance = this.speed * remaining;
    // 每个路点最多经过一次，加一次收尾。退化路线（路点全重合）因此也会停下来。
    let guard = this.waypoints.length + 1;
    while (distance > 0 && guard > 0) {
      guard -= 1;
      const step = this.nextIndex(this.segmentIndex, this.direction);
      this.resolveWaypoint(this.segmentIndex, from);
      this.resolveWaypoint(step.index, to);
      const length = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
      if (length <= 1e-6) {
        this.segmentIndex = step.index;
        this.direction = step.direction;
        this.segmentProgress = 0;
        continue;
      }
      const left = length * (1 - this.segmentProgress);
      if (distance < left) {
        this.segmentProgress += distance / length;
        distance = 0;
        break;
      }
      distance -= left;
      this.segmentIndex = step.index;
      this.direction = step.direction;
      this.segmentProgress = 0;
      if (this.waitSeconds > 0) {
        // 到站停一会儿。这一帧剩下的路程作废——停顿本来就是要让它站住。
        this.waitRemaining = this.waitSeconds;
        break;
      }
    }

    const step = this.nextIndex(this.segmentIndex, this.direction);
    this.resolveWaypoint(this.segmentIndex, from);
    this.resolveWaypoint(step.index, to);
    out.x = from.x + (to.x - from.x) * this.segmentProgress;
    out.y = from.y + (to.y - from.y) * this.segmentProgress;
    out.z = from.z + (to.z - from.z) * this.segmentProgress;
    const headingX = to.x - from.x;
    const headingZ = to.z - from.z;
    // 退化路段没有朝向可言。零向量的 atan2 是 0，照写会让它每次停下都甩向 +Z，
    // 所以这里只报告「有没有朝向」，保持原朝向的决定留给调用方。
    out.hasHeading = Math.hypot(headingX, headingZ) > 1e-6;
    out.yaw = out.hasHeading ? Math.atan2(headingX, headingZ) : 0;
    out.moving = this.waitRemaining <= 0;
    return out;
  }
}
