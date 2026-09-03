/**
 * 鼠标拖拽史莱姆的复制状态。
 *
 * 拖拽纯粹是客户端表现：它只往 HybridSlimeSimulation 写局部外力，不改变权威
 * 坐标、碰撞或玩法。因此服务端不重放它，只做数值净化、超时与转发，让同房间的
 * 其他玩家也能看到同一次形变。
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
