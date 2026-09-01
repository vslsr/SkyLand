/**
 * Actor 简易碰撞处理玩法平面的有向盒与圆柱。浏览器预测与房间 DS 共用本文件，
 * 避免两端使用不同边界；圆柱在 XZ 平面按真实圆形窄相计算，不再用外接方盒挡住边角。
 */

/** @typedef {'box' | 'cylinder'} SimpleCollisionShape */
/** @typedef {{ shape: SimpleCollisionShape, centerX: number, centerZ: number, halfWidth: number, halfLength: number, minimumY: number, maximumY: number }} SimpleCollisionDefinition */
/** @typedef {{ x: number, z: number }} CollisionPoint */
/** @typedef {{ x: number, y?: number, z: number, yaw: number }} CollisionTransform */
/** @typedef {{ collision: SimpleCollisionDefinition, transform: CollisionTransform }} SimpleCollisionInstance */
/** @typedef {{ minimumY: number, maximumY: number, maximumStepHeight?: number }} CollisionVerticalProfile */

const COLLISION_EPSILON = 1e-7;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveNumber(value, fallback) {
  const number = finiteNumber(value, fallback);
  return number > 0 ? number : fallback;
}

/**
 * 可视模型的 authoring 尺寸就是权威简易碰撞来源。Component 不再要求作者维护
 * 一份容易与模型漂移的重复配置。
 * @param {Record<string, unknown>} render
 * @param {{ radius?: number }} [dropMotion] 球形掉落物的物理半径；存在时 Transform 表示球心
 * @returns {SimpleCollisionDefinition}
 */
export function createSimpleCollisionFromRender(render, dropMotion) {
  const rollingRadius = Math.max(0, finiteNumber(dropMotion?.radius));
  if (rollingRadius > 0) {
    return createSimpleCollisionDefinition({
      shape: 'cylinder',
      halfWidth: rollingRadius,
      halfLength: rollingRadius,
      minimumY: -rollingRadius,
      maximumY: rollingRadius,
    });
  }
  const model = String(render?.model ?? '');
  if (model === 'line-art-player-slime') {
    const radius = positiveNumber(render.radius, 0.42);
    return createSimpleCollisionDefinition({
      shape: 'cylinder',
      halfWidth: radius,
      halfLength: radius,
      minimumY: 0,
      maximumY: radius * 2,
    });
  }
  if (model === 'line-art-pbf-slime') {
    const radius = positiveNumber(render.radius, 0.9);
    const collisionRadius = Math.min(
      radius * 0.95,
      positiveNumber(render.collisionRadius, radius * 0.55),
    );
    return createSimpleCollisionDefinition({
      shape: 'cylinder',
      // 外壳可以先包住障碍并形变；内部圆柱只阻止软核心穿透。
      halfWidth: collisionRadius,
      halfLength: collisionRadius,
      minimumY: 0,
      maximumY: positiveNumber(render.collisionHeight, radius * 0.76),
    });
  }
  if (model === 'line-art-raft') {
    return createSimpleCollisionDefinition({
      halfWidth: positiveNumber(render.width, 1) * 0.5,
      halfLength: positiveNumber(render.length, 1) * 0.5,
      minimumY: -0.24,
      maximumY: 2.3,
    });
  }
  if (model === 'line-art-cargo-crate') {
    const height = positiveNumber(render.height, 0.5);
    return createSimpleCollisionDefinition({
      // 箱盖比主体各向外探出 4 cm；碰撞包住模型的最外沿。
      halfWidth: (positiveNumber(render.width, 0.5) + 0.08) * 0.5,
      halfLength: (positiveNumber(render.length, 0.5) + 0.08) * 0.5,
      minimumY: 0,
      maximumY: height * 0.88,
    });
  }
  if (model === 'line-art-reef') {
    const radius = positiveNumber(render.radius, 0.5);
    const height = positiveNumber(render.height, radius);
    return createSimpleCollisionDefinition({
      halfWidth: radius,
      halfLength: radius,
      minimumY: -height * 0.48,
      maximumY: height * 1.08,
    });
  }
  if (model === 'line-art-elastic-mushroom') {
    const radius = positiveNumber(render.radius, 0.5);
    const height = positiveNumber(render.height, 0.9);
    return createSimpleCollisionDefinition({
      // 只让细小根部参与推出，宽菌盖可以悬在史莱姆头顶而不形成隐形墙。
      halfWidth: radius * 0.4,
      halfLength: radius * 0.4,
      minimumY: 0,
      maximumY: height,
    });
  }
  if (model === 'line-art-training-dummy' || model === 'line-art-focus-obelisk') {
    const radius = positiveNumber(render.radius, 0.5);
    const height = positiveNumber(render.height, 1);
    return createSimpleCollisionDefinition({
      shape: 'cylinder',
      halfWidth: radius,
      halfLength: radius,
      minimumY: 0,
      maximumY: height,
    });
  }
  if (model === 'line-art-floor-plaque') {
    return createSimpleCollisionDefinition({
      halfWidth: positiveNumber(render.width, 1) * 0.5,
      halfLength: positiveNumber(render.length, 1) * 0.5,
      minimumY: 0,
      maximumY: positiveNumber(render.height, 0.1),
    });
  }
  if (
    model === 'line-art-campfire'
    || model === 'line-art-dry-hay'
    || model === 'line-art-wood-pile'
    || model === 'line-art-stone-pile'
    || model === 'line-art-fruit-pile'
  ) {
    const radius = positiveNumber(render.radius, 0.5);
    return createSimpleCollisionDefinition({
      halfWidth: radius,
      halfLength: radius,
      minimumY: 0,
      maximumY: positiveNumber(render.height, 0.6),
    });
  }
  if (model === 'line-art-wood-log') {
    const radius = positiveNumber(render.radius, 0.1);
    return createSimpleCollisionDefinition({
      halfWidth: positiveNumber(render.length, 0.8) * 0.5,
      halfLength: radius,
      minimumY: -radius,
      maximumY: radius,
    });
  }
  throw new TypeError(`无法为模型 ${model || '<unknown>'} 生成简易碰撞`);
}

/**
 * @param {Partial<SimpleCollisionDefinition>} definition
 * @returns {SimpleCollisionDefinition}
 */
export function createSimpleCollisionDefinition(definition) {
  const minimumY = finiteNumber(definition.minimumY);
  const maximumY = finiteNumber(definition.maximumY, minimumY + 1);
  return {
    shape: definition.shape === 'cylinder' ? 'cylinder' : 'box',
    centerX: finiteNumber(definition.centerX),
    centerZ: finiteNumber(definition.centerZ),
    halfWidth: positiveNumber(definition.halfWidth, 0.01),
    halfLength: positiveNumber(definition.halfLength, 0.01),
    minimumY: Math.min(minimumY, maximumY),
    maximumY: Math.max(minimumY, maximumY),
  };
}

/**
 * 先做垂直轴筛选：不相交的悬空物不会形成隐形墙；顶部不高于可跨越高度的
 * 低矮 Actor 也不会参与 XZ 推出。坐标均为世界空间。
 * @param {SimpleCollisionInstance} instance
 * @param {CollisionVerticalProfile | undefined} profile
 */
function blocksVerticalProfile(instance, profile) {
  if (!profile) return true;
  const transformY = finiteNumber(instance.transform.y);
  const obstacleMinimumY = transformY + instance.collision.minimumY;
  const obstacleMaximumY = transformY + instance.collision.maximumY;
  const moverMinimumY = finiteNumber(profile.minimumY);
  const moverMaximumY = Math.max(moverMinimumY, finiteNumber(profile.maximumY, moverMinimumY));
  const maximumStepHeight = Math.max(0, finiteNumber(profile.maximumStepHeight));
  if (obstacleMaximumY <= moverMinimumY + maximumStepHeight + COLLISION_EPSILON) return false;
  return obstacleMinimumY < moverMaximumY - COLLISION_EPSILON
    && obstacleMaximumY > moverMinimumY + COLLISION_EPSILON;
}

/**
 * 圆形移动体与单个有向盒的最近点推出。完全位于盒内时选择最近侧面，避免零向量。
 * @param {CollisionPoint} point
 * @param {number} radius
 * @param {SimpleCollisionInstance} instance
 * @param {CollisionVerticalProfile} [verticalProfile]
 * @returns {CollisionPoint}
 */
export function resolveCircleAgainstSimpleCollision(point, radius, instance, verticalProfile) {
  if (!blocksVerticalProfile(instance, verticalProfile)) return { ...point };
  const safeRadius = Math.max(0, finiteNumber(radius));
  const transform = instance.transform;
  const collision = instance.collision;
  const yaw = finiteNumber(transform.yaw);
  const sinYaw = Math.sin(yaw);
  const cosYaw = Math.cos(yaw);
  const deltaX = finiteNumber(point.x) - finiteNumber(transform.x);
  const deltaZ = finiteNumber(point.z) - finiteNumber(transform.z);
  let localX = cosYaw * deltaX - sinYaw * deltaZ - collision.centerX;
  let localZ = sinYaw * deltaX + cosYaw * deltaZ - collision.centerZ;

  if (collision.shape === 'cylinder') {
    const obstacleRadius = Math.min(collision.halfWidth, collision.halfLength);
    const separation = obstacleRadius + safeRadius;
    const distanceSquared = localX * localX + localZ * localZ;
    if (distanceSquared >= separation * separation - COLLISION_EPSILON) return { ...point };
    if (distanceSquared > COLLISION_EPSILON) {
      const scale = separation / Math.sqrt(distanceSquared);
      localX *= scale;
      localZ *= scale;
    } else {
      // 中心完全重合时选固定的 -X，保证客户端和 DS 得到同一结果。
      localX = -separation;
      localZ = 0;
    }
    const centeredX = localX + collision.centerX;
    const centeredZ = localZ + collision.centerZ;
    return {
      x: finiteNumber(transform.x) + cosYaw * centeredX + sinYaw * centeredZ,
      z: finiteNumber(transform.z) - sinYaw * centeredX + cosYaw * centeredZ,
    };
  }

  const closestX = Math.max(-collision.halfWidth, Math.min(collision.halfWidth, localX));
  const closestZ = Math.max(-collision.halfLength, Math.min(collision.halfLength, localZ));
  const distanceX = localX - closestX;
  const distanceZ = localZ - closestZ;
  const distanceSquared = distanceX * distanceX + distanceZ * distanceZ;
  if (distanceSquared >= safeRadius * safeRadius - COLLISION_EPSILON) return { ...point };

  if (distanceSquared > COLLISION_EPSILON) {
    const distance = Math.sqrt(distanceSquared);
    localX = closestX + distanceX / distance * safeRadius;
    localZ = closestZ + distanceZ / distance * safeRadius;
  } else {
    const left = localX + collision.halfWidth;
    const right = collision.halfWidth - localX;
    const back = localZ + collision.halfLength;
    const front = collision.halfLength - localZ;
    const nearest = Math.min(left, right, back, front);
    if (nearest === left) localX = -collision.halfWidth - safeRadius;
    else if (nearest === right) localX = collision.halfWidth + safeRadius;
    else if (nearest === back) localZ = -collision.halfLength - safeRadius;
    else localZ = collision.halfLength + safeRadius;
  }

  const centeredX = localX + collision.centerX;
  const centeredZ = localZ + collision.centerZ;
  return {
    x: finiteNumber(transform.x) + cosYaw * centeredX + sinYaw * centeredZ,
    z: finiteNumber(transform.z) - sinYaw * centeredX + cosYaw * centeredZ,
  };
}

/**
 * Actor 上限是 256；这里只遍历当前房间/客户端快照中的活跃 Actor，成本不随大世界面积增长。
 * 两轮推出可处理相邻盒角落，同时保持固定上界。
 * @param {CollisionPoint} point
 * @param {number} radius
 * @param {readonly SimpleCollisionInstance[]} instances
 * @param {CollisionVerticalProfile} [verticalProfile]
 * @returns {CollisionPoint}
 */
export function resolveCircleAgainstSimpleCollisions(point, radius, instances, verticalProfile) {
  let resolved = { x: finiteNumber(point.x), z: finiteNumber(point.z) };
  for (let pass = 0; pass < 2; pass += 1) {
    const beforeX = resolved.x;
    const beforeZ = resolved.z;
    for (const instance of instances) {
      resolved = resolveCircleAgainstSimpleCollision(resolved, radius, instance, verticalProfile);
    }
    if (Math.abs(resolved.x - beforeX) < COLLISION_EPSILON
      && Math.abs(resolved.z - beforeZ) < COLLISION_EPSILON) break;
  }
  return resolved;
}

/**
 * @param {CollisionPoint} point
 * @param {number} radius
 * @param {SimpleCollisionInstance} instance
 * @param {number} [epsilon]
 */
export function circleTouchesSimpleCollision(point, radius, instance, epsilon = 1e-4) {
  const resolved = resolveCircleAgainstSimpleCollision(point, radius + Math.max(0, epsilon), instance);
  return Math.hypot(resolved.x - point.x, resolved.z - point.z) > COLLISION_EPSILON;
}
