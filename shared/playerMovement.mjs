/**
 * 玩家移动模拟。
 *
 * 浏览器的本地预测与房间进程的权威计算共用这一份实现，
 * 相同的输入在两端得到完全相同的位置，客户端才有可能做预测与和解。
 * 这里只依赖纯数学，不引入 Three.js 或任何浏览器 API。
 */

/** @typedef {{ x: number, z: number }} PlayerPoint */
/** @typedef {{ x: number, z: number, sprint: boolean }} PlayerMoveInput */
/** @typedef {{ minimumX: number, maximumX: number, minimumZ: number, maximumZ: number }} PlayerBounds */

export const PLAYER_MOVE_SPEED = 3.2;
export const PLAYER_SPRINT_MULTIPLIER = 1.65;
export const PLAYER_MAXIMUM_SPEED = PLAYER_MOVE_SPEED * PLAYER_SPRINT_MULTIPLIER;
/** 史莱姆模型的玩法平面半径；服务端碰撞与客户端模型共用。 */
export const PLAYER_COLLISION_RADIUS = 0.42;

/** 玩法平面的活动范围，与草地模型的尺寸对应。 @type {PlayerBounds} */
export const PLAYER_BOUNDS = {
  minimumX: -16,
  maximumX: 16,
  minimumZ: -21,
  maximumZ: 11,
};

export const SPAWN_SLOT_COUNT = 8;
const SPAWN_CENTER_Z = 4.5;
const SPAWN_RADIUS = 1.8;
const DEFAULT_SPAWN_CONFIG = {
  centerX: 0,
  centerZ: SPAWN_CENTER_Z,
  radius: SPAWN_RADIUS,
  slots: SPAWN_SLOT_COUNT,
};

/**
 * @param {unknown} value
 * @param {number} [fallback]
 * @returns {number}
 */
export function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

/**
 * @param {number} value
 * @param {number} minimum
 * @param {number} maximum
 * @returns {number}
 */
export function clampToRange(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

/**
 * 把任意角度收敛到 [-π, π]，避免朝向在网络上无限累加。
 * @param {number} radians
 * @returns {number}
 */
export function normalizeAngle(radians) {
  const wrapped = (radians + Math.PI) % (Math.PI * 2);
  return (wrapped < 0 ? wrapped + Math.PI * 2 : wrapped) - Math.PI;
}

/**
 * 沿最短弧插值朝向。
 * @param {number} current
 * @param {number} target
 * @param {number} amount
 * @returns {number}
 */
export function lerpAngle(current, target, amount) {
  return current + normalizeAngle(target - current) * amount;
}

/**
 * 清洗一帧移动输入：过滤非法数值，并把方向长度限制在 1 以内。
 * 这样客户端无法通过放大方向向量提高速度。
 * @param {unknown} raw
 * @returns {PlayerMoveInput}
 */
export function sanitizeMoveInput(raw) {
  const source = /** @type {Record<string, unknown> | null} */ (
    raw && typeof raw === 'object' ? raw : null
  );
  const x = toFiniteNumber(source?.x);
  const z = toFiniteNumber(source?.z);
  const sprint = source?.sprint === true;
  const length = Math.hypot(x, z);
  if (length > 1) return { x: x / length, z: z / length, sprint };
  return { x, z, sprint };
}

/**
 * @param {PlayerPoint} position
 * @param {PlayerBounds} [bounds]
 * @returns {PlayerPoint}
 */
export function clampToPlayArea(position, bounds = PLAYER_BOUNDS) {
  return {
    x: clampToRange(position.x, bounds.minimumX, bounds.maximumX),
    z: clampToRange(position.z, bounds.minimumZ, bounds.maximumZ),
  };
}

/**
 * 按一帧输入推进玩家位置。速度上限与活动范围都写死在这里，
 * 客户端只能提交方向与加速开关，无法直接决定自己走多远。
 * @param {PlayerPoint} position
 * @param {PlayerMoveInput} input
 * @param {number} deltaSeconds
 * @param {PlayerBounds} [bounds]
 * @returns {PlayerPoint}
 */
export function applyPlayerMovement(position, input, deltaSeconds, bounds = PLAYER_BOUNDS) {
  const move = sanitizeMoveInput(input);
  const length = Math.hypot(move.x, move.z);
  if (length === 0 || !(deltaSeconds > 0)) return clampToPlayArea(position, bounds);

  const speed = PLAYER_MOVE_SPEED * (move.sprint ? PLAYER_SPRINT_MULTIPLIER : 1);
  const distance = speed * deltaSeconds;
  return clampToPlayArea(
    { x: position.x + move.x * distance, z: position.z + move.z * distance },
    bounds,
  );
}

/**
 * 按房间座位号分配出生点，避免所有玩家叠在同一个坐标上。
 * @param {number} slot
 * @param {{ centerX: number, centerZ: number, radius: number, slots: number }} [spawn]
 * @param {PlayerBounds} [bounds]
 * @returns {PlayerPoint}
 */
export function createSpawnPoint(slot, spawn = DEFAULT_SPAWN_CONFIG, bounds = PLAYER_BOUNDS) {
  const slotCount = Math.max(1, Math.floor(toFiniteNumber(spawn.slots, SPAWN_SLOT_COUNT)));
  const index = Math.abs(Math.floor(toFiniteNumber(slot))) % slotCount;
  const angle = (index / slotCount) * Math.PI * 2;
  const centerX = toFiniteNumber(spawn.centerX);
  const centerZ = toFiniteNumber(spawn.centerZ, SPAWN_CENTER_Z);
  const radius = Math.max(0, toFiniteNumber(spawn.radius, SPAWN_RADIUS));
  return clampToPlayArea({
    x: centerX + Math.sin(angle) * radius,
    z: centerZ + Math.cos(angle) * radius,
  }, bounds);
}
