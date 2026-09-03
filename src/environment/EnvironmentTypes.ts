import type * as THREE from 'three';

/**
 * 天气系统每帧混出的连续场量。
 *
 * 服务端只同步离散天气枚举；这些数字是客户端在两种天气之间过渡时的当前值，
 * 昼夜系统读它来决定日月与星空被云遮住多少。
 */
export interface WeatherFieldState {
  /** 目标云朵数量（0-10），与 WEATHER_PRESETS 同量纲。 */
  clouds: number;
  /** 归一化云量，0 是完全晴朗。 */
  cloudCover: number;
  rain: number;
  snow: number;
  fog: number;
  /** 天空被压灰的程度，0-1。 */
  gray: number;
  wind: number;
  /** 当前雷闪强度，0-1；没有闪电时是 0。 */
  lightningFlash: number;
}

export interface WeatherFieldSource {
  /** 返回内部复用的只读快照，调用方不得持有或修改。 */
  getWeatherField(): Readonly<WeatherFieldState>;
}

/**
 * 昼夜系统按房间权威时刻推导出的天空状态。
 *
 * 这些量都还没有掺进天气：天气系统拿到之后再叠加灰度、雷闪与云量衰减，
 * 最终写进场景背景、雾和共享光照 uniform。
 */
export interface SkyState {
  /** 房间权威时刻，单位小时，落在 [0, 24)。 */
  timeOfDay: number;
  /** 夜晚程度，0 是完全白昼，1 是深夜。 */
  night: number;
  /** 白昼程度，等于 1 - night。 */
  dayFactor: number;
  /** 晨昏程度，0-1；日出与日落各有一个峰。 */
  twilight: number;
  /** 月光强度，0-1；夜晚、月亮在地平线以上且天空干净时才明显。 */
  moonlit: number;
  /** 未掺天气的天空底色。 */
  skyColor: THREE.Color;
  /** 未掺天气的环境光颜色。 */
  ambientColor: THREE.Color;
  /** 未掺天气的环境光亮度系数。 */
  ambientBrightness: number;
  /** 主光方向；太阳落山后交给月亮，夜里也保留方向感。 */
  sunDirection: THREE.Vector3;
  /** 朝太阳方向看时雾被染成的颜色。 */
  scatterColor: THREE.Color;
  /** 方向性散射强度，0-1；日出日落最强，太阳落到地平线以下归零。 */
  scatterStrength: number;
  /**
   * 直射光的"硬度"，0-1。
   *
   * 太阳高、天空干净时接近 1，接触阴影因此清晰；贴地或夜里趋近 0，
   * 光变成漫射，影子自然化开。
   */
  directLight: number;
  /** 日轮高度，-1 到 1。 */
  sunElevation: number;
  /** 月轮高度，-1 到 1。 */
  moonElevation: number;
}

export interface SkyStateSource {
  /** 返回内部复用的只读快照，调用方不得持有或修改。 */
  getSkyState(): Readonly<SkyState>;
}

/** 场景渲染器同步房间权威时刻的入口。 */
export interface DayNightVisualTarget {
  /**
   * 把当前时刻写进渲染世界（引擎迁移路线图 第 3 步）。
   *
   * 原来这里是 `readonly timeOfDay` + `applyServerTime`——也就是时钟住在渲染侧，
   * 「现在几点」要读回来。时钟是纯状态，现在归主线程，这里只收结果。
   *
   * @param timeOfDay 当前时刻（小时）
   * @param running 时钟走不走；冻结时星空不再旋转
   */
  setTimeOfDay(timeOfDay: number, running: boolean): void;
}
