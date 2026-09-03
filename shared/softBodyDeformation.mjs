/**
 * 软体形变的共享定义：数值净化、坐标换算、命中点求解。
 *
 * 形变有两类来源，都落在被捏那一方的 `SoftBodyDeformationComponent` 上：
 *
 * - **外壳主人自己上报的**鼠标拖拽。服务端不模拟它，只净化、超时与转发，所以
 *   这里有一份严格的入参净化。
 * - **场景里另一个 Actor 施加的外力**。今天是别人的嘴（`SoftBodyBiteSystem`），
 *   之后可以是地上的倒刺、抓手、吸盘。外力来源每 tick 给出一个世界锚点，用这里
 *   的换算落到被捏者的本地空间；命中点、抓取计数与拉断都在 Component 上。
 *
 * 两类来源都只描述形变：不掉血、不减速、也不移动任何一方。求解与渲染在客户端，
 * 过网络的只有命中点与位移六个数。
 */

/** 命中点与拖拽位移允许的最大本地偏移（米）。仅用来挡住畸形或恶意的上行数据。 */
export const SLIME_DRAG_MAXIMUM_LOCAL_OFFSET = 4;

/** 超过这段时间没有收到新的拖拽上报就认为拖拽结束（毫秒）。 */
export const SLIME_DRAG_TIMEOUT_MS = 600;

/** 命中点移动超过这个距离（米）就算换了一次抓取，接收端需要重新计算权重。 */
export const SLIME_DRAG_REGRAB_DISTANCE = 0.02;

function toBoundedNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(
    -SLIME_DRAG_MAXIMUM_LOCAL_OFFSET,
    Math.min(SLIME_DRAG_MAXIMUM_LOCAL_OFFSET, value),
  );
}

/**
 * 把上行的拖拽负载净化成六个有界数字，任何一个字段无效都整体作废。
 * 坐标全部在 Actor 本地空间，所以与玩家世界位置和朝向无关。
 */
export function sanitizeSlimeDragState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const contactX = toBoundedNumber(raw.contactX);
  const contactY = toBoundedNumber(raw.contactY);
  const contactZ = toBoundedNumber(raw.contactZ);
  const pullX = toBoundedNumber(raw.pullX);
  const pullY = toBoundedNumber(raw.pullY);
  const pullZ = toBoundedNumber(raw.pullZ);
  if (
    contactX === undefined || contactY === undefined || contactZ === undefined
    || pullX === undefined || pullY === undefined || pullZ === undefined
  ) return null;
  return { contactX, contactY, contactZ, pullX, pullY, pullZ };
}

/** 命中点换了位置就意味着松手后重新抓了一次，而不是同一次拖拽的持续更新。 */
export function isSlimeDragRegrab(previous, next) {
  if (!previous) return true;
  return Math.hypot(
    next.contactX - previous.contactX,
    next.contactY - previous.contactY,
    next.contactZ - previous.contactZ,
  ) > SLIME_DRAG_REGRAB_DISTANCE;
}

/**
 * 软体身体中心的高度比例。
 *
 * 它对应客户端 `HYBRID_SLIME_CENTER_HEIGHT_RATIO`，但这里不需要精确：命中点最终
 * 由接收端的 `beginSurfaceDrag` 吸附到最近的外壳顶点上，服务端只要给出一个落在
 * 正确那一侧的方向。
 */
export const SOFT_BODY_CENTER_HEIGHT_RATIO = 0.46;

/** 把 Actor 本地坐标按 yaw 转到世界坐标。与 ElasticTetherMutations 同一套约定。 */
export function actorLocalToWorld(origin, yaw, localX, localY, localZ, out) {
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  out.x = origin.x + localX * cos + localZ * sin;
  out.y = origin.y + localY;
  out.z = origin.z - localX * sin + localZ * cos;
  return out;
}

/** 一张嘴的世界坐标。挂点复用 PickupDrop 的口部：叼蘑菇和咬人是同一张嘴。 */
export function mouthWorld(actor, pickupDrop, out = { x: 0, y: 0, z: 0 }) {
  return actorLocalToWorld(
    actor,
    actor.yaw,
    pickupDrop.mouthLocalX,
    pickupDrop.mouthLocalY,
    pickupDrop.mouthLocalZ,
    out,
  );
}

/**
 * 世界坐标 → **外壳坐标**：只减原点，不转 yaw。形变的命中点、法线、位移全用它。
 *
 * 软体外壳不跟着 Actor 转身。渲染侧给外壳的 rig 反着转了 `-yaw`
 * （`ThreeHybridSlimeVisual` 里「外壳的弹簧坐标保持世界朝向」那一行），免得转身
 * 时整团软体被当成刚体甩过去；于是求解器的顶点坐标是「Actor 原点 + 世界轴向」。
 *
 * 拿 Actor 本地坐标（转过 yaw 的那种）算形变，整块形变就会绕 Y 轴偏掉一个 yaw：
 * 两人面对面时偏的正好是 180°，尖从被咬者的**背面**冒出来。这是这条链路上最容易
 * 踩、而且类型检查和单元测试都拦不住的一处——两侧都是三个 f32，只有画面会告诉你。
 */
export function worldToShellOffset(origin, world, out) {
  out.x = world.x - origin.x;
  out.y = world.y - origin.y;
  out.z = world.z - origin.z;
  return out;
}

/**
 * 抓住那一刻的命中点，被抓者的**外壳坐标**（见 `worldToShellOffset`：只平移，
 * 不转 yaw）。
 *
 * 取身体中心指向外力锚点的方向，落到半径上。方向对了就够：命中点会被接收端
 * 吸附到最近的外壳顶点。它之后固定不动——外壳本来也不跟着 Actor 转，所以这块皮
 * 就停在世界里的那一面上。
 *
 * 顺带写出这块皮的**朝外法线**（`normalX/Y/Z`）：它就是上面那个方向本身，和命中点
 * 同一套坐标。之后每 tick 判断「外力是把这块皮往外扯还是往身体里压」靠的就是它
 * ——往里压出来的是个凹包，不是被咬住。
 */
export function resolveSurfaceContact(radius, actor, anchorWorld, out) {
  worldToShellOffset(actor, anchorWorld, out);
  const centerY = radius * SOFT_BODY_CENTER_HEIGHT_RATIO;
  const offsetY = out.y - centerY;
  const length = Math.hypot(out.x, offsetY, out.z);
  if (!(length > 1e-6)) {
    // 锚点正好落在身体中心：退化情况取正前方，不让方向变成 NaN。
    out.x = 0;
    out.y = centerY;
    out.z = radius;
    out.normalX = 0;
    out.normalY = 0;
    out.normalZ = 1;
    return out;
  }
  const scale = radius / length;
  out.normalX = out.x / length;
  out.normalY = offsetY / length;
  out.normalZ = out.z / length;
  out.x *= scale;
  out.y = centerY + offsetY * scale;
  out.z *= scale;
  return out;
}
