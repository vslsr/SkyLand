import { simpleCollisionWorldBounds } from '../collision/collisionBox.mjs';

/**
 * 放置位的实体碰撞检查（设计稿：「放置时检测模块位置是否与玩家重叠…实体碰撞」）。
 *
 * 件还没有 Actor，所以拿它的碰撞盒定义加上放置位姿，算出一个世界空间的占地
 * （水平 AABB + 竖直范围），再和碰撞世界里的盒子、玩家的圆柱比一遍。用 AABB
 * 而不是精确的 OBB：船转了角度时会略微多拒一点点角落，但两端算出来的结果一致，
 * 而且不需要再引一套几何。
 *
 * 同一表面上已有的建造件由调用方通过 `identify` + `ignore` 排除——它们之间靠
 * 占位槽互斥（物件和墙可以贴着放），不靠碰撞。别的船上的板、木筏、树、掉落物
 * 都会挡住放置。
 */

/** 竖直方向贴着（墙脚落在地基顶面上）不算重叠；留一点余量吃掉浮点误差。 */
const VERTICAL_TOLERANCE = 0.02;
/** 水平方向往里收一点：紧挨着放的两块地基边缘相触，不该互相挡。 */
const HORIZONTAL_INSET = 0.05;

function finiteOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * @typedef {object} BuildFootprint
 * @property {number} minimumX
 * @property {number} maximumX
 * @property {number} minimumZ
 * @property {number} maximumZ
 * @property {number} minimumY
 * @property {number} maximumY
 * @property {number} x 中心（查询碰撞世界用）
 * @property {number} z
 * @property {number} radius 覆盖整个占地的查询半径
 */

/**
 * 件的占地。
 *
 * @param {{ x: number, z: number, yaw: number }} pose 世界位姿
 * @param {{ halfWidth: number, halfLength: number, minimumY: number, maximumY: number }} collision 件的碰撞盒定义
 * @param {number} y 件的世界高度（原点）
 * @returns {BuildFootprint}
 */
export function pieceFootprint(pose, collision, y) {
  const cos = Math.abs(Math.cos(finiteOr(pose.yaw)));
  const sin = Math.abs(Math.sin(finiteOr(pose.yaw)));
  const halfWidth = Math.max(0, finiteOr(collision.halfWidth) - HORIZONTAL_INSET);
  const halfLength = Math.max(0, finiteOr(collision.halfLength) - HORIZONTAL_INSET);
  const extentX = cos * halfWidth + sin * halfLength;
  const extentZ = sin * halfWidth + cos * halfLength;
  return {
    x: pose.x,
    z: pose.z,
    minimumX: pose.x - extentX,
    maximumX: pose.x + extentX,
    minimumZ: pose.z - extentZ,
    maximumZ: pose.z + extentZ,
    minimumY: y + finiteOr(collision.minimumY),
    maximumY: y + finiteOr(collision.maximumY),
    radius: Math.hypot(extentX, extentZ) + 0.5,
  };
}

function overlapsRange(footprint, minimumX, maximumX, minimumZ, maximumZ, minimumY, maximumY) {
  return footprint.minimumX < maximumX && footprint.maximumX > minimumX
    && footprint.minimumZ < maximumZ && footprint.maximumZ > minimumZ
    && footprint.minimumY < maximumY - VERTICAL_TOLERANCE
    && footprint.maximumY > minimumY + VERTICAL_TOLERANCE;
}

/**
 * 占地和一个碰撞世界实例（`{ collision, transform }`）重叠吗。
 */
export function footprintOverlapsInstance(footprint, instance) {
  const bounds = simpleCollisionWorldBounds(instance);
  const baseY = finiteOr(instance.transform?.y);
  return overlapsRange(
    footprint,
    bounds.minimumX,
    bounds.maximumX,
    bounds.minimumZ,
    bounds.maximumZ,
    baseY + finiteOr(instance.collision?.minimumY),
    baseY + finiteOr(instance.collision?.maximumY),
  );
}

/**
 * 占地和一个圆柱（玩家）重叠吗。
 *
 * @param {{ x: number, y?: number, z: number, radius: number, height: number }} cylinder
 */
export function footprintOverlapsCylinder(footprint, cylinder) {
  const radius = Math.max(0, finiteOr(cylinder.radius));
  const baseY = finiteOr(cylinder.y);
  return overlapsRange(
    footprint,
    cylinder.x - radius,
    cylinder.x + radius,
    cylinder.z - radius,
    cylinder.z + radius,
    baseY,
    baseY + Math.max(0, finiteOr(cylinder.height)),
  );
}

/**
 * 占地是否被任何实体挡住。
 *
 * @param {BuildFootprint} footprint
 * @param {{
 *   forEachNear(x: number, z: number, radius: number, visit: (instance: object) => void): void,
 *   identify?: (instance: object) => string | undefined,
 *   ignore?: (actorId: string) => boolean,
 *   cylinders?: Iterable<{ x: number, y?: number, z: number, radius: number, height: number }>,
 * }} world
 */
export function footprintBlocked(footprint, world) {
  for (const cylinder of world.cylinders ?? []) {
    if (footprintOverlapsCylinder(footprint, cylinder)) return true;
  }
  let blocked = false;
  world.forEachNear(footprint.x, footprint.z, footprint.radius, (instance) => {
    if (blocked) return;
    const actorId = world.identify?.(instance);
    if (actorId !== undefined && world.ignore?.(actorId)) return;
    if (footprintOverlapsInstance(footprint, instance)) blocked = true;
  });
  return blocked;
}
