import * as THREE from 'three';
import { HOURS_PER_DAY, normalizeTimeOfDay } from '../../shared/dayNight.mjs';

export interface SkyGradientStop {
  /** 关键时刻，单位小时。 */
  hour: number;
  /** 该时刻的天空色。 */
  color: number;
  /**
   * 与场景自己的纸面背景色混合的比例。
   *
   * 白昼段取 1：天空就是场景配置的背景色，所以关掉昼夜的场景和接入之前
   * 完全一致。晨昏保留相当一部分纸面色——远景雾跟着天空走，纯饱和的橙红
   * 会糊满整块海面或草原，那不是这套线稿该有的克制色调；夜里则完全交给
   * 参考渐变自己的深蓝。
   */
  backgroundMix: number;
}

/**
 * 线稿参考项目的一日天空渐变。
 *
 * 顺序按小时严格递增，首尾各有一个 0 点与 24 点，跨零点时直接在这两个
 * 端点之间插值，不需要特判。
 */
export const SKY_GRADIENT_STOPS: readonly SkyGradientStop[] = Object.freeze([
  { hour: 0, color: 0x040710, backgroundMix: 0 },
  { hour: 3.5, color: 0x0d1322, backgroundMix: 0 },
  { hour: 4.5, color: 0x1b2138, backgroundMix: 0 },
  { hour: 5.3, color: 0x43355e, backgroundMix: 0.04 },
  { hour: 6, color: 0x9c5a74, backgroundMix: 0.12 },
  { hour: 6.4, color: 0xe8876a, backgroundMix: 0.3 },
  { hour: 6.9, color: 0xffab7c, backgroundMix: 0.46 },
  { hour: 7.5, color: 0xf7e3c8, backgroundMix: 0.62 },
  { hour: 9, color: 0xfdfbf6, backgroundMix: 1 },
  { hour: 15, color: 0xfdfbf6, backgroundMix: 1 },
  { hour: 16.6, color: 0xfdeada, backgroundMix: 0.66 },
  { hour: 17.4, color: 0xfcd3a0, backgroundMix: 0.45 },
  { hour: 18.1, color: 0xffa268, backgroundMix: 0.42 },
  { hour: 18.6, color: 0xf77452, backgroundMix: 0.34 },
  { hour: 19.1, color: 0xc75a6e, backgroundMix: 0.16 },
  { hour: 19.6, color: 0x6e4a78, backgroundMix: 0.06 },
  { hour: 20.2, color: 0x33355e, backgroundMix: 0 },
  { hour: 21, color: 0x141a30, backgroundMix: 0 },
  { hour: 22, color: 0x080b14, backgroundMix: 0 },
  { hour: HOURS_PER_DAY, color: 0x040710, backgroundMix: 0 },
]);

const SCRATCH_COLOR = new THREE.Color();

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * 采样某个时刻的天空色。
 *
 * @param hour 时刻，单位小时
 * @param background 场景自己的纸面背景色；白昼段完全由它决定
 * @param out 复用的输出颜色
 */
export function sampleSkyColor(
  hour: number,
  background: THREE.Color,
  out: THREE.Color,
): THREE.Color {
  const time = normalizeTimeOfDay(hour);
  for (let index = 0; index < SKY_GRADIENT_STOPS.length - 1; index += 1) {
    const from = SKY_GRADIENT_STOPS[index];
    const to = SKY_GRADIENT_STOPS[index + 1];
    if (time < from.hour || time > to.hour) continue;
    const amount = to.hour === from.hour ? 0 : (time - from.hour) / (to.hour - from.hour);
    out.setHex(from.color).lerp(SCRATCH_COLOR.setHex(to.color), amount);
    const backgroundMix = lerp(from.backgroundMix, to.backgroundMix, amount);
    return backgroundMix > 0 ? out.lerp(background, backgroundMix) : out;
  }
  return out.setHex(SKY_GRADIENT_STOPS[0].color);
}

/** 夜晚程度：19 点后到 5 点前是整夜，5-7 与 17-19 之间线性过渡。 */
export function nightFactor(hour: number): number {
  const time = normalizeTimeOfDay(hour);
  if (time < 5 || time > 19) return 1;
  if (time < 7) return (7 - time) / 2;
  if (time > 17) return (time - 17) / 2;
  return 0;
}

/**
 * 天空暗到什么程度，0 是亮天，1 是深夜的墨蓝。
 *
 * 星空按它决定该不该亮：黄昏的橙色天空虽然已经过了「入夜」判定，但仍然
 * 太亮，星星这时冒出来会很假；被天气压灰的白天同理。
 */
export function skyDarkness(skyColor: THREE.Color): number {
  const luminance = skyColor.r * 0.3 + skyColor.g * 0.59 + skyColor.b * 0.11;
  return clamp01((0.42 - luminance) / 0.34);
}

/** 晨昏程度：日出与日落各一个正弦峰，用来给环境光加暖调。 */
export function twilightFactor(hour: number): number {
  const time = normalizeTimeOfDay(hour);
  if (time > 5 && time < 7.5) return Math.sin((time - 5) / 2.5 * Math.PI);
  if (time > 16.5 && time < 19) return Math.sin((time - 16.5) / 2.5 * Math.PI);
  return 0;
}

/** 日轮相位：6 点从东方升起，18 点在西方落下。 */
export function sunAngle(hour: number): number {
  return (normalizeTimeOfDay(hour) - 6) / 12 * Math.PI;
}

/** 月轮相位：18 点升起，次日 6 点落下，和日轮正好错开。 */
export function moonAngle(hour: number): number {
  const shifted = normalizeTimeOfDay(hour) - 18;
  return (shifted < 0 ? shifted + HOURS_PER_DAY : shifted) / 12 * Math.PI;
}

export { clamp01 };
