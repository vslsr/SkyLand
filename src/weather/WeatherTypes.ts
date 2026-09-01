import {
  DEFAULT_WEATHER as SHARED_DEFAULT_WEATHER,
  WEATHER_TYPES as SHARED_WEATHER_TYPES,
  isWeatherType as isSharedWeatherType,
} from '../../shared/weather.mjs';

export type WeatherType =
  | 'sunny'
  | 'cloudy'
  | 'fog'
  | 'rain'
  | 'storm'
  | 'snow'
  | 'blizzard';

export const WEATHER_TYPES = SHARED_WEATHER_TYPES as readonly WeatherType[];
export const DEFAULT_WEATHER = SHARED_DEFAULT_WEATHER as WeatherType;

export const WEATHER_LABELS: Readonly<Record<WeatherType, string>> = {
  sunny: '晴',
  cloudy: '多云',
  fog: '雾',
  rain: '雨',
  storm: '暴雨',
  snow: '雪',
  blizzard: '暴雪',
};

export function isWeatherType(value: unknown): value is WeatherType {
  return isSharedWeatherType(value);
}
