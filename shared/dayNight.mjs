/**
 * 房间权威昼夜时钟的稳定协议值。
 *
 * 服务端只同步「现在几点」和「一整天要走多少真实秒」这两个数；日轮角度、
 * 天空渐变、环境光和星空全部由客户端本地推导。客户端在两帧快照之间用同一
 * 份数学继续推进，因此不会因为快照频率而出现时间跳变。
 */

/** @typedef {{ enabled: boolean, paused: boolean, startHour: number, dayLengthSeconds: number }} DayNightSettings */

export const HOURS_PER_DAY = 24;

/** 一整天（24 小时）对应的真实秒数默认值。 */
export const DEFAULT_DAY_LENGTH_SECONDS = 900;
export const MINIMUM_DAY_LENGTH_SECONDS = 20;
export const MAXIMUM_DAY_LENGTH_SECONDS = 86_400;

/**
 * 没有配置时房间停在正午：天空正好等于场景自己的纸面背景色，环境光是白光，
 * 关掉昼夜的场景因此和接入昼夜之前逐像素一致。
 */
export const DEFAULT_START_HOUR = 12;

/** 调试与场景配置里可以直接引用的整点时段。 */
export const DAY_PHASE_HOURS = Object.freeze({
  midnight: 0,
  dawn: 6,
  noon: 12,
  dusk: 18.6,
});

/** @type {DayNightSettings} */
export const DEFAULT_DAY_NIGHT_SETTINGS = Object.freeze({
  enabled: false,
  paused: false,
  startHour: DEFAULT_START_HOUR,
  dayLengthSeconds: DEFAULT_DAY_LENGTH_SECONDS,
});

/**
 * 把任意小时数折回 [0, 24)。负数、超过一天和 24 本身都会得到合法值。
 * @param {number} hours
 * @returns {number}
 */
export function normalizeTimeOfDay(hours) {
  if (!Number.isFinite(hours)) return 0;
  const wrapped = hours % HOURS_PER_DAY;
  return wrapped < 0 ? wrapped + HOURS_PER_DAY : wrapped;
}

/**
 * 一整天走 dayLengthSeconds 真实秒时，每真实秒推进多少小时。
 * @param {number} dayLengthSeconds
 * @returns {number}
 */
export function hoursPerSecond(dayLengthSeconds) {
  if (!Number.isFinite(dayLengthSeconds) || dayLengthSeconds <= 0) return 0;
  return HOURS_PER_DAY / dayLengthSeconds;
}

/**
 * 按真实经过时间推进时钟。
 * @param {number} timeOfDay
 * @param {number} dayLengthSeconds
 * @param {number} deltaSeconds
 * @returns {number}
 */
export function advanceTimeOfDay(timeOfDay, dayLengthSeconds, deltaSeconds) {
  const rate = hoursPerSecond(dayLengthSeconds);
  if (rate === 0 || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) {
    return normalizeTimeOfDay(timeOfDay);
  }
  return normalizeTimeOfDay(timeOfDay + rate * deltaSeconds);
}

/**
 * 两个时刻之间的最短带符号差值，落在 (-12, 12]。
 * 客户端用它判断该平滑追赶还是直接跳到服务端时间。
 * @param {number} fromHours
 * @param {number} toHours
 * @returns {number}
 */
export function shortestTimeOfDayDelta(fromHours, toHours) {
  const difference = normalizeTimeOfDay(toHours) - normalizeTimeOfDay(fromHours);
  if (difference > HOURS_PER_DAY / 2) return difference - HOURS_PER_DAY;
  if (difference <= -HOURS_PER_DAY / 2) return difference + HOURS_PER_DAY;
  return difference;
}

/** @param {unknown} value @returns {value is number} */
export function isTimeOfDay(value) {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && value < HOURS_PER_DAY;
}
