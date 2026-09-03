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

/**
 * 一块外壳同时最多被几个外力抓着。
 *
 * 每多一张嘴就多一个突起向量，画面上多一个尖，位移相加——所以这是个上限，不是
 * 「一次只能一个」。定这个数是因为参数段是定长的；三张嘴咬同一只史莱姆已经是
 * 围殴，再多的尖也分不出来。玩法侧与渲染侧共用它，省得两边各写一个 3。
 */
export const MAX_SOFT_BODY_HOLDERS = 3;

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
 * 被外力捏出来的那个**突起向量**，被捏者的外壳坐标（世界轴向，不转 yaw）。
 *
 * 方向是「身体中心 → 抓握点」：牙在哪一侧，尖就从哪一侧长出来。施力方绕过去、
 * 从被咬者身上越过去，这个方向自己就跟着转，不需要换抓取，也没有「命中点还留在
 * 原来那一面」的问题——那正是按一块固定的皮做位移时最难处理的一段。
 *
 * 长度按拉扯量算：抓握点离外壳越远，尖越长；贴着皮甚至埋进外壳里的时候（嘴挂在
 * 施力方身前，贴身咬本来就是这样）保底 `minimumDepth`，因为牙咬住本来就会捏起
 * 一块皮，那是牙的属性，不是两人间距的属性。
 *
 * 只有三个数过网络，而且是连续量：两帧之间直接插值，不需要 revision。
 */
export function resolveGripTip(radius, actor, gripWorld, minimumDepth, out) {
  const centerY = radius * SOFT_BODY_CENTER_HEIGHT_RATIO;
  const deltaX = gripWorld.x - actor.x;
  const deltaY = gripWorld.y - (actor.y + centerY);
  const deltaZ = gripWorld.z - actor.z;
  const distance = Math.hypot(deltaX, deltaY, deltaZ);
  if (!(distance > 1e-6)) {
    // 抓握点正落在身体中心：方向退化，取正前方，不让它变成 NaN。
    out.x = 0;
    out.y = 0;
    out.z = minimumDepth;
    return out;
  }
  const amount = Math.max(minimumDepth, distance - radius);
  const scale = amount / distance;
  out.x = deltaX * scale;
  out.y = deltaY * scale;
  out.z = deltaZ * scale;
  return out;
}
