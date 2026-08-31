/**
 * 简易碰撞盒的几何运算：世界包围盒与扫掠球求交。
 *
 * 简易碰撞（shared/actor/simpleCollision.mjs）的盒子在 XZ 平面上是有向的
 * （带 yaw），在 Y 上是轴对齐的区间。推出算法只用到 XZ，但相机悬臂必须知道
 * 高度——玩家能从树冠下面走过去，镜头却不该从树冠里穿过去。所以这里的运算
 * 都是三维的，Y 取自 transform.y（缺省 0）加上定义里的 minimumY/maximumY。
 *
 * 局部坐标的换算与 simpleCollision.mjs 完全一致，不要在这里另起一套约定。
 */

const EPSILON = 1e-9;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * 有向盒在世界 XZ 平面上的轴对齐包围盒。宽相登记用它。
 * @param {{ collision: object, transform: object }} instance
 * @param {number} [margin] 额外外扩（米）
 * @returns {{ minimumX: number, maximumX: number, minimumZ: number, maximumZ: number }}
 */
export function simpleCollisionWorldBounds(instance, margin = 0) {
  const { collision, transform } = instance;
  const yaw = finiteNumber(transform.yaw);
  const sinYaw = Math.sin(yaw);
  const cosYaw = Math.cos(yaw);
  const centerX = finiteNumber(collision.centerX);
  const centerZ = finiteNumber(collision.centerZ);
  const halfWidth = finiteNumber(collision.halfWidth);
  const halfLength = finiteNumber(collision.halfLength);
  const worldX = finiteNumber(transform.x) + cosYaw * centerX + sinYaw * centerZ;
  const worldZ = finiteNumber(transform.z) - sinYaw * centerX + cosYaw * centerZ;
  const extentX = Math.abs(cosYaw) * halfWidth + Math.abs(sinYaw) * halfLength + margin;
  const extentZ = Math.abs(sinYaw) * halfWidth + Math.abs(cosYaw) * halfLength + margin;
  return {
    minimumX: worldX - extentX,
    maximumX: worldX + extentX,
    minimumZ: worldZ - extentZ,
    maximumZ: worldZ + extentZ,
  };
}

/**
 * 一段线段外扩成的球，最早在什么时候碰到这个盒子。
 *
 * 做法是闵可夫斯基和：把盒子按探针半径向外撑大，再拿线段做 slab 求交。
 * 撑大的盒子在角上是方的而不是圆的，所以贴着盒角掠过时会比真实的球早一点
 * 判定命中——对相机来说这个方向是安全的：宁可早一点把镜头拉近，也不要
 * 晚一点让它切进模型里。
 *
 * @param {readonly [number, number, number]} start 线段起点（世界坐标）
 * @param {readonly [number, number, number]} end 线段终点
 * @param {number} radius 探针半径
 * @param {{ collision: object, transform: object }} instance
 * @returns {number} 命中处的线段参数 t ∈ [0, 1]；没碰到返回 1；起点就在盒内返回 0
 */
export function sweepSphereAgainstSimpleCollision(start, end, radius, instance) {
  const { collision, transform } = instance;
  const safeRadius = Math.max(0, finiteNumber(radius));
  const yaw = finiteNumber(transform.yaw);
  const sinYaw = Math.sin(yaw);
  const cosYaw = Math.cos(yaw);
  const transformX = finiteNumber(transform.x);
  const transformY = finiteNumber(transform.y);
  const transformZ = finiteNumber(transform.z);

  const startDeltaX = finiteNumber(start[0]) - transformX;
  const startDeltaZ = finiteNumber(start[2]) - transformZ;
  const endDeltaX = finiteNumber(end[0]) - transformX;
  const endDeltaZ = finiteNumber(end[2]) - transformZ;

  const centerX = finiteNumber(collision.centerX);
  const centerZ = finiteNumber(collision.centerZ);
  const startLocalX = cosYaw * startDeltaX - sinYaw * startDeltaZ - centerX;
  const startLocalZ = sinYaw * startDeltaX + cosYaw * startDeltaZ - centerZ;
  const endLocalX = cosYaw * endDeltaX - sinYaw * endDeltaZ - centerX;
  const endLocalZ = sinYaw * endDeltaX + cosYaw * endDeltaZ - centerZ;
  const startLocalY = finiteNumber(start[1]);
  const endLocalY = finiteNumber(end[1]);

  const halfWidth = finiteNumber(collision.halfWidth) + safeRadius;
  const halfLength = finiteNumber(collision.halfLength) + safeRadius;
  const minimumY = transformY + finiteNumber(collision.minimumY) - safeRadius;
  const maximumY = transformY + finiteNumber(collision.maximumY) + safeRadius;

  let enter = 0;
  let exit = 1;

  // 三条 slab 依次收紧 [enter, exit]；任何一条让区间空掉就说明整段都没碰到。
  const axes = [
    [startLocalX, endLocalX - startLocalX, -halfWidth, halfWidth],
    [startLocalY, endLocalY - startLocalY, minimumY, maximumY],
    [startLocalZ, endLocalZ - startLocalZ, -halfLength, halfLength],
  ];
  for (const [origin, direction, minimum, maximum] of axes) {
    if (Math.abs(direction) < EPSILON) {
      if (origin < minimum || origin > maximum) return 1;
      continue;
    }
    let near = (minimum - origin) / direction;
    let far = (maximum - origin) / direction;
    if (near > far) {
      const swap = near;
      near = far;
      far = swap;
    }
    if (near > enter) enter = near;
    if (far < exit) exit = far;
    if (enter > exit) return 1;
  }
  return enter <= exit ? enter : 1;
}
