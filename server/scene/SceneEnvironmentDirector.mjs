import { DEFAULT_WEATHER, isWeatherType } from '../../shared/weather.mjs';
import {
  DEFAULT_DAY_LENGTH_SECONDS,
  DEFAULT_START_HOUR,
  advanceTimeOfDay,
  isTimeOfDay,
  normalizeTimeOfDay,
} from '../../shared/dayNight.mjs';

/** 房间内推进环境状态时，单帧最多认下多少真实秒；进程卡顿后不会让天空瞬移。 */
const MAXIMUM_STEP_SECONDS = 1;

function createRandom(seed) {
  let state = (seed >>> 0) || 0x9e37_79b9;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function roundTime(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * 房间权威的天气与昼夜推进器。
 *
 * 场景 JSON 的 `environment` 决定「怎么切」：初始天气、是否自动轮换、一整天
 * 走多少真实秒，以及客户端能不能提出切换请求。这里只维护离散天气枚举和一个
 * 时刻标量，粒子、天空渐变、日月和星空全部留给客户端表现。
 */
export class SceneEnvironmentDirector {
  constructor(definition = {}, options = {}) {
    const weather = definition.weather ?? {};
    const dayNight = definition.dayNight ?? {};
    this.weather = isWeatherType(weather.initial) ? weather.initial : DEFAULT_WEATHER;
    this.allowWeatherControl = weather.allowPlayerControl !== false;
    this.cycle = weather.cycle && weather.cycle.enabled !== false
      && Array.isArray(weather.cycle.candidates)
      && weather.cycle.candidates.length > 1
      ? {
          minimumSeconds: weather.cycle.minimumSeconds,
          maximumSeconds: weather.cycle.maximumSeconds,
          candidates: weather.cycle.candidates.slice(),
        }
      : undefined;
    this.dayNightEnabled = dayNight.enabled === true;
    this.paused = dayNight.paused === true;
    this.allowTimeControl = dayNight.allowPlayerControl !== false;
    this.dayLengthSeconds = Number.isFinite(dayNight.dayLengthSeconds)
      ? dayNight.dayLengthSeconds
      : DEFAULT_DAY_LENGTH_SECONDS;
    this.timeOfDay = normalizeTimeOfDay(
      Number.isFinite(dayNight.startHour) ? dayNight.startHour : DEFAULT_START_HOUR,
    );
    this.random = createRandom(options.seed ?? 0x51ca_b1e7);
    this.secondsUntilWeatherChange = this.cycle ? this.sampleCycleInterval() : Infinity;
  }

  /** 时钟真的在走的时候才向客户端播报速率；冻结的场景播报 0。 */
  get activeDayLengthSeconds() {
    return this.dayNightEnabled && !this.paused ? this.dayLengthSeconds : 0;
  }

  sampleCycleInterval() {
    const { minimumSeconds, maximumSeconds } = this.cycle;
    return minimumSeconds + this.random() * (maximumSeconds - minimumSeconds);
  }

  /** 从候选里挑一个和当前不同的天气，保证每次轮换都看得出来。 */
  pickNextWeather() {
    const others = this.cycle.candidates.filter((candidate) => candidate !== this.weather);
    if (others.length === 0) return this.weather;
    return others[Math.min(others.length - 1, Math.floor(this.random() * others.length))];
  }

  advance(deltaSeconds) {
    const step = Math.max(0, Math.min(deltaSeconds, MAXIMUM_STEP_SECONDS));
    if (step === 0) return;
    if (this.dayNightEnabled && !this.paused) {
      this.timeOfDay = advanceTimeOfDay(this.timeOfDay, this.dayLengthSeconds, step);
    }
    if (!this.cycle) return;
    this.secondsUntilWeatherChange -= step;
    if (this.secondsUntilWeatherChange > 0) return;
    this.weather = this.pickNextWeather();
    this.secondsUntilWeatherChange = this.sampleCycleInterval();
  }

  /**
   * 客户端的天气切换请求。场景关掉 allowPlayerControl 后一律拒绝，
   * 房间天气就只由配置的轮换驱动。
   */
  requestWeather(weather) {
    if (!this.allowWeatherControl || !isWeatherType(weather)) return false;
    this.weather = weather;
    // 手动切过之后重新计时，避免刚切完就被轮换覆盖。
    if (this.cycle) this.secondsUntilWeatherChange = this.sampleCycleInterval();
    return true;
  }

  /** 客户端的时刻跳转请求；冻结或禁用昼夜的场景不接受。 */
  requestTimeOfDay(timeOfDay) {
    if (!this.allowTimeControl || !this.dayNightEnabled || !isTimeOfDay(timeOfDay)) return false;
    this.timeOfDay = normalizeTimeOfDay(timeOfDay);
    return true;
  }

  /** 进入房间快照的最小环境状态。 */
  snapshot() {
    return {
      weather: this.weather,
      timeOfDay: roundTime(this.timeOfDay),
      dayLength: roundTime(this.activeDayLengthSeconds),
    };
  }
}
