/**
 * Actor 简易碰撞处理玩法平面的有向盒与圆柱。浏览器预测与房间 DS 共用本文件，
 * 避免两端使用不同边界；圆柱在 XZ 平面按真实圆形窄相计算，不再用外接方盒挡住边角。
 */

/** @typedef {'box' | 'cylinder'} SimpleCollisionShape */
/** @typedef {{ shape: SimpleCollisionShape, centerX: number, centerZ: number, halfWidth: number, halfLength: number, minimumY: number, maximumY: number, supportShape: SimpleCollisionShape, supportHalfWidth: number, supportHalfLength: number }} SimpleCollisionDefinition */
/** @typedef {{ x: number, z: number }} CollisionPoint */
/** @typedef {{ x: number, y?: number, z: number, yaw: number }} CollisionTransform */
/** @typedef {{ collision: SimpleCollisionDefinition, transform: CollisionTransform }} SimpleCollisionInstance */
/** @typedef {{ minimumY: number, maximumY: number, maximumStepHeight?: number }} CollisionVerticalProfile */

import { leggedSlimeTopY } from './leggedSlimeShape.mjs';

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
  if (model === 'line-art-legged-slime') {
    const radius = positiveNumber(render.radius, 0.42);
    const hipHeight = positiveNumber(render.hipHeight, radius * 1.8);
    return createSimpleCollisionDefinition({
      shape: 'cylinder',
      // 腿不参与碰撞：它们是贴着地面采样点摆出来的表现，两根细杆挡住玩家只会
      // 让这只史莱姆卡在自己的脚上。权威圆柱仍然从地面一直包到身体顶部。
      halfWidth: radius,
      halfLength: radius,
      minimumY: 0,
      maximumY: leggedSlimeTopY(hipHeight, radius),
    });
  }
  if (model === 'line-art-raft') {
    return createSimpleCollisionDefinition({
      halfWidth: positiveNumber(render.width, 1) * 0.5,
      halfLength: positiveNumber(render.length, 1) * 0.5,
      minimumY: -0.24,
      // 甲板可见顶面在根节点上方约 0.47m；旧值 2.3m 把桅杆也包进一个
      // 巨型盒，角色控制器只会撞上一堵隐形墙而无法站上木筏。
      maximumY: 0.47,
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
  if (model === 'line-art-storage-chest') {
    const width = positiveNumber(render.width, 0.5);
    const length = positiveNumber(render.length, 0.5);
    const height = positiveNumber(render.height, 0.5);
    // 盖沿与束带比箱体各向外探出一个板厚；碰撞包住模型的最外沿。
    const thickness = Math.min(width, length) * 0.075;
    return createSimpleCollisionDefinition({
      halfWidth: (width + thickness) * 0.5,
      halfLength: (length + thickness) * 0.5,
      minimumY: 0,
      // 只包到箱体加盖板，不含掀开后翻到背面去的那一块：盖子开着时人不该被挡住。
      maximumY: height * 0.86,
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
      // 根部保持细小；Rapier 适配层会把下面的 supportShape 生成为独立薄菌盖，
      // 因此菌盖顶面可站立，而不再用一根宽盒从地面制造隐形墙。
      halfWidth: radius * 0.4,
      halfLength: radius * 0.4,
      minimumY: 0,
      maximumY: height,
      // 支撑 authoring 会成为第二枚薄圆柱 collider，而不是旧查询的特殊分支。
      supportShape: 'cylinder',
      supportHalfWidth: radius,
      supportHalfLength: radius,
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
    || model === 'line-art-stone-pile'
    || model === 'line-art-fruit-pile'
    || model === 'line-art-mushroom-pile'
    || model === 'line-art-slingshot-pile'
  ) {
    const radius = positiveNumber(render.radius, 0.5);
    return createSimpleCollisionDefinition({
      halfWidth: radius,
      halfLength: radius,
      minimumY: 0,
      maximumY: positiveNumber(render.height, 0.6),
    });
  }
  // 木头是一根躺着的六棱柱：长轴沿 X，所以盒子是「长 × 直径」，不是一个方墩。
  if (model === 'line-art-wood-pile') {
    const radius = positiveNumber(render.radius, 0.1);
    return createSimpleCollisionDefinition({
      halfWidth: positiveNumber(render.length, 0.8) * 0.5,
      halfLength: radius,
      minimumY: -radius,
      maximumY: radius,
    });
  }
  if (model === 'line-art-build-foundation') {
    // 地基从 y=0 长到 thickness：盒子就是那块板，顶面是能站上去的那一层。
    const size = positiveNumber(render.size, 2);
    return createSimpleCollisionDefinition({
      halfWidth: size * 0.5,
      halfLength: size * 0.5,
      minimumY: 0,
      maximumY: positiveNumber(render.thickness, 0.12),
    });
  }
  if (model === 'line-art-build-wall') {
    // 墙沿本地 X 展开、薄边沿 Z：整堵墙都挡路也挡镜头，没有可站的顶面。
    return createSimpleCollisionDefinition({
      halfWidth: positiveNumber(render.width, 2) * 0.5,
      halfLength: positiveNumber(render.thickness, 0.2) * 0.5,
      minimumY: 0,
      maximumY: positiveNumber(render.height, 1.5),
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
  const halfWidth = positiveNumber(definition.halfWidth, 0.01);
  const halfLength = positiveNumber(definition.halfLength, 0.01);
  return {
    shape: definition.shape === 'cylinder' ? 'cylinder' : 'box',
    centerX: finiteNumber(definition.centerX),
    centerZ: finiteNumber(definition.centerZ),
    halfWidth,
    halfLength,
    minimumY: Math.min(minimumY, maximumY),
    maximumY: Math.max(minimumY, maximumY),
    supportShape: definition.supportShape === 'cylinder'
      ? 'cylinder'
      : definition.supportShape === 'box'
        ? 'box'
        : definition.shape === 'cylinder' ? 'cylinder' : 'box',
    supportHalfWidth: positiveNumber(definition.supportHalfWidth, halfWidth),
    supportHalfLength: positiveNumber(definition.supportHalfLength, halfLength),
  };
}

/**
 * 常规角色控制器的向下支撑窄相：圆形脚印必须覆盖物件顶面，并且顶面必须落在
 * 本帧脚底从 maximumY 到 minimumY 的向下扫掠区间内。返回世界空间顶面高度。
 * @param {CollisionPoint} point
 * @param {number} radius
 * @param {SimpleCollisionInstance} instance
 * @param {number} minimumY
 * @param {number} maximumY
 * @returns {number | undefined}
 */
export function supportHeightForSimpleCollision(
  point,
  radius,
  instance,
  minimumY,
  maximumY,
) {
  const lowerY = Math.min(finiteNumber(minimumY), finiteNumber(maximumY));
  const upperY = Math.max(finiteNumber(minimumY), finiteNumber(maximumY));
  const collision = instance.collision;
  const transform = instance.transform;
  const supportY = finiteNumber(transform.y) + finiteNumber(collision.maximumY);
  if (supportY < lowerY - COLLISION_EPSILON || supportY > upperY + COLLISION_EPSILON) {
    return undefined;
  }

  const yaw = finiteNumber(transform.yaw);
  const sinYaw = Math.sin(yaw);
  const cosYaw = Math.cos(yaw);
  const deltaX = finiteNumber(point.x) - finiteNumber(transform.x);
  const deltaZ = finiteNumber(point.z) - finiteNumber(transform.z);
  const localX = cosYaw * deltaX - sinYaw * deltaZ - finiteNumber(collision.centerX);
  const localZ = sinYaw * deltaX + cosYaw * deltaZ - finiteNumber(collision.centerZ);
  const supportHalfWidth = positiveNumber(
    collision.supportHalfWidth,
    positiveNumber(collision.halfWidth, 0.01),
  );
  const supportHalfLength = positiveNumber(
    collision.supportHalfLength,
    positiveNumber(collision.halfLength, 0.01),
  );
  const safeRadius = Math.max(0, finiteNumber(radius));
  const supportShape = collision.supportShape ?? collision.shape;

  if (supportShape === 'cylinder') {
    const separation = Math.min(supportHalfWidth, supportHalfLength) + safeRadius;
    return localX * localX + localZ * localZ <= separation * separation + COLLISION_EPSILON
      ? supportY
      : undefined;
  }

  const closestX = Math.max(-supportHalfWidth, Math.min(supportHalfWidth, localX));
  const closestZ = Math.max(-supportHalfLength, Math.min(supportHalfLength, localZ));
  const distanceX = localX - closestX;
  const distanceZ = localZ - closestZ;
  return distanceX * distanceX + distanceZ * distanceZ
    <= safeRadius * safeRadius + COLLISION_EPSILON
    ? supportY
    : undefined;
}

/**
 * 圆形角色脚印是否覆盖碰撞体的水平截面。竖直扫掠用主碰撞形状，向下支撑
 * 查询可选择更宽的 supportShape（例如蘑菇菌盖）。
 * @param {CollisionPoint} point
 * @param {number} radius
 * @param {SimpleCollisionInstance} instance
 * @param {boolean} [support]
 * @returns {boolean}
 */
export function circleOverlapsSimpleCollisionFootprint(point, radius, instance, support = false) {
  const collision = instance.collision;
  const transform = instance.transform;
  const yaw = finiteNumber(transform.yaw);
  const sinYaw = Math.sin(yaw);
  const cosYaw = Math.cos(yaw);
  const deltaX = finiteNumber(point.x) - finiteNumber(transform.x);
  const deltaZ = finiteNumber(point.z) - finiteNumber(transform.z);
  const localX = cosYaw * deltaX - sinYaw * deltaZ - finiteNumber(collision.centerX);
  const localZ = sinYaw * deltaX + cosYaw * deltaZ - finiteNumber(collision.centerZ);
  const halfWidth = support
    ? positiveNumber(collision.supportHalfWidth, positiveNumber(collision.halfWidth, 0.01))
    : positiveNumber(collision.halfWidth, 0.01);
  const halfLength = support
    ? positiveNumber(collision.supportHalfLength, positiveNumber(collision.halfLength, 0.01))
    : positiveNumber(collision.halfLength, 0.01);
  const shape = support ? (collision.supportShape ?? collision.shape) : collision.shape;
  const safeRadius = Math.max(0, finiteNumber(radius));
  if (shape === 'cylinder') {
    const separation = Math.min(halfWidth, halfLength) + safeRadius;
    return localX * localX + localZ * localZ <= separation * separation + COLLISION_EPSILON;
  }
  const closestX = Math.max(-halfWidth, Math.min(halfWidth, localX));
  const closestZ = Math.max(-halfLength, Math.min(halfLength, localZ));
  const distanceX = localX - closestX;
  const distanceZ = localZ - closestZ;
  return distanceX * distanceX + distanceZ * distanceZ
    <= safeRadius * safeRadius + COLLISION_EPSILON;
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
