/**
 * 简易碰撞盒的几何运算：世界包围盒与扫掠球求交。
 *
 * 简易碰撞（shared/actor/simpleCollision.mjs）在 XZ 平面支持有向盒与圆柱，
 * 在 Y 上是轴对齐的区间。推出算法只用到 XZ，但相机悬臂必须知道
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
  const supportHalfWidth = finiteNumber(collision.supportHalfWidth, halfWidth);
  const supportHalfLength = finiteNumber(collision.supportHalfLength, halfLength);
  const worldX = finiteNumber(transform.x) + cosYaw * centerX + sinYaw * centerZ;
  const worldZ = finiteNumber(transform.z) - sinYaw * centerX + cosYaw * centerZ;
  const collisionRadius = Math.min(halfWidth, halfLength);
  const collisionExtentX = collision.shape === 'cylinder'
    ? collisionRadius
    : Math.abs(cosYaw) * halfWidth + Math.abs(sinYaw) * halfLength;
  const collisionExtentZ = collision.shape === 'cylinder'
    ? collisionRadius
    : Math.abs(sinYaw) * halfWidth + Math.abs(cosYaw) * halfLength;
  const supportRadius = Math.min(supportHalfWidth, supportHalfLength);
  const supportExtentX = collision.supportShape === 'cylinder'
    ? supportRadius
    : Math.abs(cosYaw) * supportHalfWidth + Math.abs(sinYaw) * supportHalfLength;
  const supportExtentZ = collision.supportShape === 'cylinder'
    ? supportRadius
    : Math.abs(sinYaw) * supportHalfWidth + Math.abs(cosYaw) * supportHalfLength;
  const extentX = Math.max(collisionExtentX, supportExtentX) + margin;
  const extentZ = Math.max(collisionExtentZ, supportExtentZ) + margin;
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

  if (collision.shape === 'cylinder') {
    const directionX = endLocalX - startLocalX;
    const directionZ = endLocalZ - startLocalZ;
    const expandedRadius = Math.min(
      finiteNumber(collision.halfWidth),
      finiteNumber(collision.halfLength),
    ) + safeRadius;
    const horizontalA = directionX * directionX + directionZ * directionZ;
    const horizontalC = (
      startLocalX * startLocalX + startLocalZ * startLocalZ
      - expandedRadius * expandedRadius
    );
    let enter = 0;
    let exit = 1;
    if (horizontalC > 0) {
      if (horizontalA < EPSILON) return 1;
      const horizontalB = 2 * (startLocalX * directionX + startLocalZ * directionZ);
      const discriminant = horizontalB * horizontalB - 4 * horizontalA * horizontalC;
      if (discriminant < 0) return 1;
      const root = Math.sqrt(discriminant);
      enter = Math.max(enter, (-horizontalB - root) / (2 * horizontalA));
      exit = Math.min(exit, (-horizontalB + root) / (2 * horizontalA));
      if (enter > exit) return 1;
    }
    const directionY = endLocalY - startLocalY;
    if (Math.abs(directionY) < EPSILON) {
      if (startLocalY < minimumY || startLocalY > maximumY) return 1;
    } else {
      let near = (minimumY - startLocalY) / directionY;
      let far = (maximumY - startLocalY) / directionY;
      if (near > far) [near, far] = [far, near];
      enter = Math.max(enter, near);
      exit = Math.min(exit, far);
    }
    return enter <= exit && exit >= 0 && enter <= 1 ? Math.max(0, enter) : 1;
  }

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

/**
 * 在固定脚底高度上扫掠一个竖直圆柱，返回最早的水平命中与世界空间法线。
 *
 * 角色体与盒子的水平闵可夫斯基和仍采用保守的“外扩有向盒”；圆柱障碍则用
 * 真实圆对圆二次方程。宽相只负责给候选，本函数决定实际命中。
 *
 * @param {{ x: number, z: number }} start
 * @param {{ x: number, z: number }} end
 * @param {number} radius
 * @param {{ minimumY: number, maximumY: number, maximumStepHeight?: number }} verticalProfile
 * @param {{ collision: object, transform: object }} instance
 * @returns {{ t: number, normalX: number, normalZ: number } | undefined}
 */
export function sweepCircleAgainstSimpleCollision(
  start,
  end,
  radius,
  verticalProfile,
  instance,
) {
  const { collision, transform } = instance;
  const transformY = finiteNumber(transform.y);
  const obstacleMinimumY = transformY + finiteNumber(collision.minimumY);
  const obstacleMaximumY = transformY + finiteNumber(collision.maximumY);
  const moverMinimumY = finiteNumber(verticalProfile?.minimumY);
  const moverMaximumY = Math.max(
    moverMinimumY,
    finiteNumber(verticalProfile?.maximumY, moverMinimumY),
  );
  const maximumStepHeight = Math.max(0, finiteNumber(verticalProfile?.maximumStepHeight));
  if (obstacleMaximumY <= moverMinimumY + maximumStepHeight + EPSILON) return undefined;
  if (
    obstacleMinimumY >= moverMaximumY - EPSILON
    || obstacleMaximumY <= moverMinimumY + EPSILON
  ) {
    return undefined;
  }

  const safeRadius = Math.max(0, finiteNumber(radius));
  const yaw = finiteNumber(transform.yaw);
  const sinYaw = Math.sin(yaw);
  const cosYaw = Math.cos(yaw);
  const transformX = finiteNumber(transform.x);
  const transformZ = finiteNumber(transform.z);
  const centerX = finiteNumber(collision.centerX);
  const centerZ = finiteNumber(collision.centerZ);

  const startDeltaX = finiteNumber(start.x) - transformX;
  const startDeltaZ = finiteNumber(start.z) - transformZ;
  const endDeltaX = finiteNumber(end.x) - transformX;
  const endDeltaZ = finiteNumber(end.z) - transformZ;
  const startLocalX = cosYaw * startDeltaX - sinYaw * startDeltaZ - centerX;
  const startLocalZ = sinYaw * startDeltaX + cosYaw * startDeltaZ - centerZ;
  const endLocalX = cosYaw * endDeltaX - sinYaw * endDeltaZ - centerX;
  const endLocalZ = sinYaw * endDeltaX + cosYaw * endDeltaZ - centerZ;
  const directionX = endLocalX - startLocalX;
  const directionZ = endLocalZ - startLocalZ;
  if (directionX * directionX + directionZ * directionZ < EPSILON) return undefined;

  let hitT;
  let localNormalX = 0;
  let localNormalZ = 0;
  if (collision.shape === 'cylinder') {
    const expandedRadius = Math.min(
      finiteNumber(collision.halfWidth),
      finiteNumber(collision.halfLength),
    ) + safeRadius;
    const a = directionX * directionX + directionZ * directionZ;
    const b = 2 * (startLocalX * directionX + startLocalZ * directionZ);
    const c = startLocalX * startLocalX + startLocalZ * startLocalZ
      - expandedRadius * expandedRadius;
    if (c <= EPSILON) {
      // 已经贴在边界上且正离开时不能重新把角色锁住。
      if (b >= 0) return undefined;
      hitT = 0;
    } else {
      const discriminant = b * b - 4 * a * c;
      if (discriminant < 0) return undefined;
      hitT = (-b - Math.sqrt(discriminant)) / (2 * a);
      if (hitT < -EPSILON || hitT > 1 + EPSILON) return undefined;
      hitT = Math.max(0, Math.min(1, hitT));
    }
    const hitX = startLocalX + directionX * hitT;
    const hitZ = startLocalZ + directionZ * hitT;
    const length = Math.hypot(hitX, hitZ);
    if (length > EPSILON) {
      localNormalX = hitX / length;
      localNormalZ = hitZ / length;
    } else {
      const directionLength = Math.hypot(directionX, directionZ) || 1;
      localNormalX = -directionX / directionLength;
      localNormalZ = -directionZ / directionLength;
    }
  } else {
    const halfWidth = finiteNumber(collision.halfWidth) + safeRadius;
    const halfLength = finiteNumber(collision.halfLength) + safeRadius;
    let enter = 0;
    let exit = 1;
    const startInside = Math.abs(startLocalX) < halfWidth - EPSILON
      && Math.abs(startLocalZ) < halfLength - EPSILON;
    const axes = [
      {
        origin: startLocalX,
        direction: directionX,
        minimum: -halfWidth,
        maximum: halfWidth,
        nearNormalX: directionX > 0 ? -1 : 1,
        nearNormalZ: 0,
      },
      {
        origin: startLocalZ,
        direction: directionZ,
        minimum: -halfLength,
        maximum: halfLength,
        nearNormalX: 0,
        nearNormalZ: directionZ > 0 ? -1 : 1,
      },
    ];
    for (const axis of axes) {
      if (Math.abs(axis.direction) < EPSILON) {
        if (axis.origin < axis.minimum || axis.origin > axis.maximum) return undefined;
        continue;
      }
      let near = (axis.minimum - axis.origin) / axis.direction;
      let far = (axis.maximum - axis.origin) / axis.direction;
      if (near > far) [near, far] = [far, near];
      if (near > enter) {
        enter = near;
        localNormalX = axis.nearNormalX;
        localNormalZ = axis.nearNormalZ;
      }
      exit = Math.min(exit, far);
      if (enter > exit) return undefined;
    }
    if (exit < -EPSILON || enter > 1 + EPSILON) return undefined;
    if (startInside) {
      const left = startLocalX + halfWidth;
      const right = halfWidth - startLocalX;
      const back = startLocalZ + halfLength;
      const front = halfLength - startLocalZ;
      const nearest = Math.min(left, right, back, front);
      if (nearest === left) [localNormalX, localNormalZ] = [-1, 0];
      else if (nearest === right) [localNormalX, localNormalZ] = [1, 0];
      else if (nearest === back) [localNormalX, localNormalZ] = [0, -1];
      else [localNormalX, localNormalZ] = [0, 1];
      if (directionX * localNormalX + directionZ * localNormalZ >= 0) return undefined;
      hitT = 0;
    } else {
      hitT = Math.max(0, enter);
    }
  }

  return {
    t: hitT,
    normalX: cosYaw * localNormalX + sinYaw * localNormalZ,
    normalZ: -sinYaw * localNormalX + cosYaw * localNormalZ,
  };
}
