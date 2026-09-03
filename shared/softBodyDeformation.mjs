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
 * 把一个**世界方向**转到 Actor 本地空间。只转不平移：位移是向量不是点，
 * 用点的换算会把两者的位置差也算进去，方向立刻就偏了。
 */
export function actorWorldVectorToLocal(yaw, x, y, z, out) {
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  out.x = x * cos - z * sin;
  out.y = y;
  out.z = x * sin + z * cos;
  return out;
}

/** 世界坐标转回 Actor 本地坐标，是 `actorLocalToWorld` 的逆。 */
export function actorWorldToLocal(origin, yaw, world, out) {
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  const deltaX = world.x - origin.x;
  const deltaZ = world.z - origin.z;
  out.x = deltaX * cos - deltaZ * sin;
  out.y = world.y - origin.y;
  out.z = deltaX * sin + deltaZ * cos;
  return out;
}

/**
 * 抓住那一刻的命中点，被抓者本地坐标。
 *
 * 取身体中心指向外力锚点的方向，落到半径上。方向对了就够：命中点会被接收端
 * 吸附到最近的外壳顶点，而且抓住之后它固定不动，被抓者转身时那块皮跟着一起转。
 */
export function resolveSurfaceContact(radius, actor, anchorWorld, out) {
  actorWorldToLocal(actor, actor.yaw, anchorWorld, out);
  const centerY = radius * SOFT_BODY_CENTER_HEIGHT_RATIO;
  const offsetY = out.y - centerY;
  const length = Math.hypot(out.x, offsetY, out.z);
  if (!(length > 1e-6)) {
    // 锚点正好落在身体中心：退化情况取正前方，不让方向变成 NaN。
    out.x = 0;
    out.y = centerY;
    out.z = radius;
    return out;
  }
  const scale = radius / length;
  out.x *= scale;
  out.y = centerY + offsetY * scale;
  out.z *= scale;
  return out;
}
