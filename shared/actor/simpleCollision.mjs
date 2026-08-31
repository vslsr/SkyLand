/**
 * Actor 简易碰撞只处理玩法平面的有向盒。它和参考项目的 XZ 包围盒推出算法一致，
 * 但额外支持 Actor yaw；浏览器预测与房间 DS 共用本文件，避免两端使用不同边界。
 */

/** @typedef {{ centerX: number, centerZ: number, halfWidth: number, halfLength: number, minimumY: number, maximumY: number }} SimpleCollisionDefinition */
/** @typedef {{ x: number, z: number }} CollisionPoint */
/** @typedef {{ x: number, z: number, yaw: number }} CollisionTransform */
/** @typedef {{ collision: SimpleCollisionDefinition, transform: CollisionTransform }} SimpleCollisionInstance */

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
 * @returns {SimpleCollisionDefinition}
 */
export function createSimpleCollisionFromRender(render) {
  const model = String(render?.model ?? '');
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
    centerX: finiteNumber(definition.centerX),
    centerZ: finiteNumber(definition.centerZ),
    halfWidth: positiveNumber(definition.halfWidth, 0.01),
    halfLength: positiveNumber(definition.halfLength, 0.01),
    minimumY: Math.min(minimumY, maximumY),
    maximumY: Math.max(minimumY, maximumY),
  };
}

/**
 * 圆形移动体与单个有向盒的最近点推出。完全位于盒内时选择最近侧面，避免零向量。
 * @param {CollisionPoint} point
 * @param {number} radius
 * @param {SimpleCollisionInstance} instance
 * @returns {CollisionPoint}
 */
export function resolveCircleAgainstSimpleCollision(point, radius, instance) {
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
 * @returns {CollisionPoint}
 */
export function resolveCircleAgainstSimpleCollisions(point, radius, instances) {
  let resolved = { x: finiteNumber(point.x), z: finiteNumber(point.z) };
  for (let pass = 0; pass < 2; pass += 1) {
    const beforeX = resolved.x;
    const beforeZ = resolved.z;
    for (const instance of instances) {
      resolved = resolveCircleAgainstSimpleCollision(resolved, radius, instance);
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
