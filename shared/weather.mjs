/** @typedef {'sunny' | 'cloudy' | 'fog' | 'rain' | 'storm' | 'snow' | 'blizzard'} WeatherType */

/**
 * 房间权威天气的稳定协议值。服务端只同步这个离散状态；云、雨雪和闪电
 * 都由每个客户端在本地玩家周围按 chunk 激活并表现。
 * @type {readonly WeatherType[]}
 */
export const WEATHER_TYPES = Object.freeze([
  'sunny',
  'cloudy',
  'fog',
  'rain',
  'storm',
  'snow',
  'blizzard',
]);

/** @type {WeatherType} */
export const DEFAULT_WEATHER = 'sunny';

/** @param {unknown} value @returns {value is WeatherType} */
export function isWeatherType(value) {
  return typeof value === 'string' && WEATHER_TYPES.includes(value);
}
