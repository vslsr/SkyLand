import * as THREE from 'three';

/**
 * 草地外观参数。
 *
 * 场景配置里只有一个 `palette.grass`，但一片可信的草至少需要根部、叶尖和
 * 枯斑三种颜色。与其让每个场景 JSON 都多填两三个色号（还很容易配歪），
 * 这里从那一个基色按 HSL 推导出整套渐变，场景仍可显式覆盖。
 */

export interface GrassGradient {
  /** 根部：更暗、更饱和，带一点土色。 */
  root: THREE.Color;
  /** 叶尖：更亮、偏黄绿，模拟受光与新叶。 */
  tip: THREE.Color;
  /** 枯斑：由极低频色斑噪声混入的偏黄地块。 */
  dry: THREE.Color;
}

export interface GrassGradientOverrides {
  root?: THREE.ColorRepresentation;
  tip?: THREE.ColorRepresentation;
  dry?: THREE.ColorRepresentation;
}

/** 风的表现参数。方向与强度由天气系统的共享 uniform 提供，这里只管形状。 */
export interface GrassWindSettings {
  /** 阵风噪声的世界缩放（1/米）。越小风团越大。 */
  gustScale: number;
  /** 阵风噪声的滚动速度（米/秒），决定「风过境」扫过的快慢。 */
  gustSpeed: number;
  /** 细颤噪声的世界缩放（1/米）。 */
  flutterScale: number;
  /** 细颤噪声的滚动速度（米/秒）。 */
  flutterSpeed: number;
  /** 无风时的基础摇摆量，按叶片高度归一。 */
  baseSway: number;
  /** 阵风锋面处额外增加的摇摆量。 */
  gustSway: number;
  /** 侧向颤动量，让叶片不只沿风向前后倒。 */
  flutterSway: number;
}

/** 噪声驱动的高低差。 */
export interface GrassHeightVariationSettings {
  /** 团簇噪声的世界缩放（1/米）。0.045 约等于 22 米一个高矮团。 */
  clumpScale: number;
  /** 团簇造成的高度比例振幅，0.35 表示 ±35%。 */
  clumpAmount: number;
  /** 逐叶随机的高度比例振幅，压在团簇之上打散规整感。 */
  bladeAmount: number;
  /** 叶片自身的自然弯曲弧度，按叶高归一。 */
  curveAmount: number;
}

export const DEFAULT_GRASS_WIND: GrassWindSettings = Object.freeze({
  gustScale: 0.016,
  gustSpeed: 3.4,
  flutterScale: 0.16,
  flutterSpeed: 1.1,
  baseSway: 0.075,
  gustSway: 0.26,
  flutterSway: 0.055,
});

export const DEFAULT_GRASS_HEIGHT_VARIATION: GrassHeightVariationSettings = Object.freeze({
  clumpScale: 0.045,
  clumpAmount: 0.34,
  bladeAmount: 0.16,
  curveAmount: 0.2,
});

/** 色斑噪声最多把基色推向枯色多少。 */
export const GRASS_DRY_PATCH_STRENGTH = 0.34;

/**
 * 从场景基色推导根/尖/枯三色。
 *
 * 只改 HSL 的分量而不是硬编码色号，这样蓝绿的月色草地与黄绿的正午草地
 * 都能得到方向一致的渐变，不需要每张地图重新调色。
 */
export function createGrassGradient(
  color: THREE.ColorRepresentation,
  overrides: GrassGradientOverrides = {},
): GrassGradient {
  const base = new THREE.Color(color);
  const hsl = { h: 0, s: 0, l: 0 };
  base.getHSL(hsl);

  return {
    root: overrides.root !== undefined
      ? new THREE.Color(overrides.root)
      : hslColor(hsl.h + 0.014, hsl.s * 1.25, hsl.l * 0.5),
    tip: overrides.tip !== undefined
      ? new THREE.Color(overrides.tip)
      : hslColor(hsl.h - 0.045, hsl.s * 0.92, mixTowardOne(hsl.l, 0.14)),
    dry: overrides.dry !== undefined
      ? new THREE.Color(overrides.dry)
      : hslColor(hsl.h - 0.088, hsl.s * 0.72, mixTowardOne(hsl.l, 0.1)),
  };
}

/** 色相是环形的，饱和度与亮度必须夹紧，否则推导会翻到另一侧。 */
function hslColor(hue: number, saturation: number, lightness: number): THREE.Color {
  return new THREE.Color().setHSL(
    ((hue % 1) + 1) % 1,
    THREE.MathUtils.clamp(saturation, 0, 1),
    THREE.MathUtils.clamp(lightness, 0, 1),
  );
}

/** 按比例向 1 靠拢：亮色不会被推爆，暗色也能被明显提亮。 */
function mixTowardOne(value: number, ratio: number): number {
  return value + (1 - value) * ratio;
}
