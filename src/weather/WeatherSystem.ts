import * as THREE from 'three';
import {
  listChunksInRadius,
  toChunkCoordinate,
  toChunkKey,
} from '../../shared/world/chunkKey.mjs';
import { CHUNK_SIZE } from '../../shared/world/worldConfig.mjs';
import type {
  SkyState,
  SkyStateSource,
  WeatherFieldSource,
  WeatherFieldState,
} from '../environment/EnvironmentTypes';
import { CONTACT_SHADOW_UNIFORMS } from '../materials/createContactShadowMaterial';
import type { SceneEnvironmentRuntime } from '../materials/createFillMaterial';
import { applyEnvironmentInk, resetEnvironmentInk } from '../materials/lineMaterials';
import {
  RAIN_SPLASH_SEGMENTS_PER_EFFECT,
  WEATHER_VISUAL_CAPACITY,
  createWeatherVisuals,
} from '../models/weather/createWeatherVisuals';
import type {
  SceneUpdateContext,
  SceneVisualSystem,
  WeatherVisualTarget,
} from '../scene/SceneVisualSystem';
import {
  DEFAULT_WEATHER,
  isWeatherType,
  type WeatherType,
} from './WeatherTypes';

interface WeatherPreset {
  clouds: number;
  rain: number;
  snow: number;
  fog: number;
  gray: number;
  wind: number;
}

interface RainDrop {
  x: number;
  y: number;
  z: number;
  groundY: number;
  speed: number;
  /** 出生时已有粗略高度；接近地面后只再精确采样一次。 */
  groundProbePending: boolean;
}

interface RainSplash {
  x: number;
  y: number;
  z: number;
  age: number;
  lifetime: number;
  active: boolean;
}

interface SnowFlake {
  x: number;
  y: number;
  z: number;
  groundY: number;
  speed: number;
  phase: number;
  amplitude: number;
  frequency: number;
  rotation: number;
  rotationSpeed: number;
}

interface WeatherChunk {
  readonly key: string;
  /** Chunk 自己持有确定性随机流；窗口回收粒子时从玩家所在 Chunk 取样。 */
  readonly random: () => number;
}

export interface WeatherEnvironmentDefinition {
  backgroundColor: string;
  fogColor: string;
  fogNear: number;
  fogFar: number;
  runtime?: SceneEnvironmentRuntime;
  sampleGroundHeight?: (x: number, z: number) => number;
  /**
   * 昼夜系统提供的天空状态。缺省时天空恒为场景背景色，等同于没有昼夜的场景。
   */
  sky?: SkyStateSource;
  /** 场景地面色；半球光里从下方反弹回来的那一半取它的色相。 */
  groundColor?: string;
}

const WEATHER_PRESETS: Readonly<Record<WeatherType, WeatherPreset>> = {
  sunny: { clouds: 2, rain: 0, snow: 0, fog: 0, gray: 0, wind: 0.2 },
  cloudy: { clouds: 10, rain: 0, snow: 0, fog: 0.15, gray: 0.25, wind: 0.4 },
  fog: { clouds: 4, rain: 0, snow: 0, fog: 1, gray: 0.45, wind: 0.1 },
  rain: { clouds: 6, rain: 240, snow: 0, fog: 0.35, gray: 0.5, wind: 0.6 },
  storm: { clouds: 10, rain: 520, snow: 0, fog: 0.6, gray: 0.65, wind: 1.6 },
  snow: { clouds: 5, rain: 0, snow: 200, fog: 0.35, gray: 0.35, wind: 0.3 },
  blizzard: { clouds: 9, rain: 0, snow: 420, fog: 0.6, gray: 0.55, wind: 1.8 },
};

const WEATHER_CHUNK_RADIUS = 1;
const MAXIMUM_ACTIVE_CHUNKS = (WEATHER_CHUNK_RADIUS * 2 + 1) ** 2;
const PRECIPITATION_HEIGHT = 18;
const PRECIPITATION_WINDOW_HALF_SIZE = 17;
const PRECIPITATION_RESPAWN_MINIMUM_HEIGHT = 11;
const PRECIPITATION_RESPAWN_HEIGHT_RANGE = 3;
const RAIN_GROUND_PROBE_HEIGHT = 2.5;
const RAIN_SPLASH_LIFETIME_MINIMUM = 0.22;
const RAIN_SPLASH_LIFETIME_RANGE = 0.12;
const CLOUD_WRAP_HALF_SIZE = 70;
const WIND_X = 0.86;
const WIND_Z = 0.51;
const TRANSITION_SPEED = 0.55;

/** 没有昼夜系统时的中性白光。 */
const NEUTRAL_AMBIENT_COLOR = new THREE.Color(0xffffff);

/** 半球染色与墨线染色的强度：0 是完全中性，1 是完全跟着环境色走。 */
const SKY_TINT_STRENGTH = 0.5;
const BOUNCE_TINT_STRENGTH = 0.5;
const INK_TINT_STRENGTH = 0.6;

/** 感知亮度；正午的中性白光为 1，用来判断纸面被压暗到什么程度。 */
function luminance(color: THREE.Color): number {
  return color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722;
}

/**
 * 把一个颜色归一化到平均值 1，再按 strength 混回白色。
 *
 * 结果只带色相不带亮度，所以它可以直接乘在已经算好的光照上：正午的中性
 * 白光归一化后就是 1，画面和没有染色时逐像素一致。
 */
function normalizeTint(source: THREE.Color, strength: number, out: THREE.Color): THREE.Color {
  const mean = (source.r + source.g + source.b) / 3;
  if (!(mean > 1e-4)) return out.setRGB(1, 1, 1);
  const scale = 1 / mean;
  return out.setRGB(
    lerp(1, source.r * scale, strength),
    lerp(1, source.g * scale, strength),
    lerp(1, source.b * scale, strength),
  );
}

export const WEATHER_PARTICLE_LIMITS = Object.freeze({
  chunkSize: CHUNK_SIZE,
  activationRadius: WEATHER_CHUNK_RADIUS,
  maximumActiveChunks: MAXIMUM_ACTIVE_CHUNKS,
  rainDrops: WEATHER_VISUAL_CAPACITY.rainDrops,
  rainSplashes: WEATHER_VISUAL_CAPACITY.rainSplashes,
  snowFlakes: WEATHER_VISUAL_CAPACITY.snowFlakes,
});

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function createChunkSeed(chunkX: number, chunkZ: number): number {
  let seed = 0x79a3_5f21;
  seed ^= Math.imul(chunkX | 0, 0x1f12_3bb5);
  seed ^= Math.imul(chunkZ | 0, 0x5f35_6495);
  seed = Math.imul(seed ^ seed >>> 16, 0x45d9_f3b);
  return (seed ^ seed >>> 16) >>> 0;
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function grayscale(color: THREE.Color, out: THREE.Color): THREE.Color {
  const gray = color.r * 0.3 + color.g * 0.59 + color.b * 0.11;
  return out.setScalar(gray * 0.9 + 0.08);
}

function wrapAround(value: number, center: number, halfSize: number): number {
  const diameter = halfSize * 2;
  return center + ((((value - center + halfSize) % diameter) + diameter) % diameter) - halfSize;
}

/**
 * 客户端局部天气表现。
 *
 * 服务端只同步七态天气枚举。客户端把玩家所在 chunk 周围 3×3 的天气块激活，
 * 每块拥有固定槽位；雨雪顶点使用绝对世界坐标，玩家在 chunk 内移动时不会拖着
 * 整片粒子平移。跨边界或快速传送只替换离开的块，不沿路补算。
 *
 * 这里同时是场景环境的唯一写入方：昼夜系统算出天空底色与环境光，天气在它
 * 上面叠加云量、灰度与雷闪，然后一次性写进 scene.background、scene.fog 和
 * 共享光照 uniform。
 */
export class WeatherSystem implements SceneVisualSystem, WeatherVisualTarget, WeatherFieldSource {
  public readonly root: THREE.Group;

  private readonly visuals = createWeatherVisuals();
  private readonly scene: THREE.Scene;
  private readonly runtime?: SceneEnvironmentRuntime;
  private readonly sky?: SkyStateSource;
  private readonly sampleGroundHeight: (x: number, z: number) => number;
  private readonly baseBackground: THREE.Color;
  private readonly baseFogColor: THREE.Color;
  /** 作者写下的雾色相对背景色的偏移；天空随昼夜变化时保留这份偏移。 */
  private readonly fogColorOffset: THREE.Color;
  /** 半球光下半部分的基准色，取场景地面色。 */
  private readonly baseBounceColor: THREE.Color;
  private readonly baseFogNear: number;
  private readonly baseFogFar: number;
  private readonly activeChunks = new Map<string, WeatherChunk>();
  private activeChunkOrder: WeatherChunk[] = [];
  private readonly cloudOpacities = new Float32Array(WEATHER_VISUAL_CAPACITY.clouds);
  private readonly random = createRandom(0x79a3_5f21);
  /** 玩家附近 34×34 米的固定容量雨幕；世界再大也只维护这 560 个槽位。 */
  private readonly rainDrops: RainDrop[] = [];
  /** 共享几何体背后的固定水花状态池。 */
  private readonly rainSplashes: RainSplash[] = [];
  /** 雪花使用同一局部窗口；440 个槽位与参考实现一致。 */
  private readonly snowFlakes: SnowFlake[] = [];
  private readonly backgroundColor = new THREE.Color();
  private readonly fogColor = new THREE.Color();
  private readonly grayColor = new THREE.Color();
  private readonly cloudColor = new THREE.Color();
  private readonly cloudLitColor = new THREE.Color();
  private readonly tintColor = new THREE.Color();
  private readonly scatterColor = new THREE.Color();
  /** 云影噪声的滚动量，跟着风累积，不随帧率变化。 */
  private cloudShadowOffsetX = 0;
  private cloudShadowOffsetZ = 0;
  private readonly ambientColor = new THREE.Color(0xffffff);
  private readonly stormAmbientColor = new THREE.Color(0x87909c);
  private readonly lightningColor = new THREE.Color(0xffffff);
  private readonly stormCloudColor = new THREE.Color(0x5a6470);
  private weatherType: WeatherType = DEFAULT_WEATHER;
  private state: WeatherPreset = { ...WEATHER_PRESETS[DEFAULT_WEATHER] };
  private focusChunkX: number | undefined;
  private focusChunkZ: number | undefined;
  private focusX = 0;
  private focusZ = 0;
  private visibleRainCount = 0;
  private visibleRainSplashCount = 0;
  private rainSplashCursor = 0;
  private visibleSnowCount = 0;
  private currentDaylight = 1;
  private lightningRemaining = 0;
  private currentLightningFlash = 0;
  private nextLightningSeconds = 7;
  private disposed = false;
  /** 每帧原地复用的天气场量快照，供昼夜系统读取云量与灰度。 */
  private readonly field: WeatherFieldState = {
    clouds: WEATHER_PRESETS[DEFAULT_WEATHER].clouds,
    cloudCover: WEATHER_PRESETS[DEFAULT_WEATHER].clouds / 10,
    rain: 0,
    snow: 0,
    fog: 0,
    gray: 0,
    wind: WEATHER_PRESETS[DEFAULT_WEATHER].wind,
    lightningFlash: 0,
  };

  public constructor(scene: THREE.Scene, environment: WeatherEnvironmentDefinition) {
    this.scene = scene;
    this.root = this.visuals.root;
    this.runtime = environment.runtime;
    this.sky = environment.sky;
    this.sampleGroundHeight = environment.sampleGroundHeight ?? (() => 0);
    this.baseBackground = new THREE.Color(environment.backgroundColor);
    this.baseFogColor = new THREE.Color(environment.fogColor);
    this.fogColorOffset = new THREE.Color(
      this.baseFogColor.r - this.baseBackground.r,
      this.baseFogColor.g - this.baseBackground.g,
      this.baseFogColor.b - this.baseBackground.b,
    );
    this.baseBounceColor = new THREE.Color(environment.groundColor ?? 0xffffff);
    this.baseFogNear = environment.fogNear;
    this.baseFogFar = environment.fogFar;
    this.syncActiveChunks(0, 0);
    for (let index = 0; index < WEATHER_VISUAL_CAPACITY.rainDrops; index += 1) {
      this.rainDrops.push(this.createRainDrop(0, 0, false));
    }
    for (let index = 0; index < WEATHER_VISUAL_CAPACITY.rainSplashes; index += 1) {
      this.rainSplashes.push({
        x: 0,
        y: 0,
        z: 0,
        age: 0,
        lifetime: RAIN_SPLASH_LIFETIME_MINIMUM,
        active: false,
      });
    }
    for (let index = 0; index < WEATHER_VISUAL_CAPACITY.snowFlakes; index += 1) {
      this.snowFlakes.push(this.createSnowFlake(0, 0, false));
    }
  }

  public get weather(): WeatherType {
    return this.weatherType;
  }

  public setWeather(weather: WeatherType): void {
    if (!isWeatherType(weather)) throw new TypeError(`未知天气：${String(weather)}`);
    if (weather === this.weatherType) return;
    this.weatherType = weather;
    if (weather === 'storm') this.nextLightningSeconds = 2.5 + this.random() * 4;
  }

  public update(
    deltaSeconds: number,
    elapsedSeconds: number,
    context?: SceneUpdateContext,
  ): void {
    if (this.disposed) return;
    const dt = Math.max(0, Math.min(deltaSeconds, 0.1));
    if (context && Number.isFinite(context.focusX) && Number.isFinite(context.focusZ)) {
      this.focusX = context.focusX;
      this.focusZ = context.focusZ;
      this.syncActiveChunks(context.focusX, context.focusZ);
      this.syncRainWindow(context.focusX, context.focusZ);
      this.syncSnowWindow(context.focusX, context.focusZ);
    }

    const target = WEATHER_PRESETS[this.weatherType];
    const transition = 1 - Math.exp(-dt * TRANSITION_SPEED);
    this.state.clouds = lerp(this.state.clouds, target.clouds, transition);
    this.state.rain = lerp(this.state.rain, target.rain, transition);
    this.state.snow = lerp(this.state.snow, target.snow, transition);
    this.state.fog = lerp(this.state.fog, target.fog, transition);
    this.state.gray = lerp(this.state.gray, target.gray, transition);
    this.state.wind = lerp(this.state.wind, target.wind, transition);

    this.updateLightning(dt);
    this.publishWeatherField();
    this.updateEnvironment(dt);
    this.updateClouds(dt, elapsedSeconds);
    this.updateRain(dt);
    this.updateRainSplashes(dt);
    this.updateSnow(dt, elapsedSeconds);
  }

  public getParticleCounts(): { rain: number; rainSplashes: number; snow: number } {
    return {
      rain: this.visibleRainCount,
      rainSplashes: this.visibleRainSplashCount,
      snow: this.visibleSnowCount,
    };
  }

  /** 供 F8 诊断与单测读取；返回副本，外部无法修改激活集合。 */
  public getActiveChunkKeys(): readonly string[] {
    return this.activeChunkOrder.map((chunk) => chunk.key);
  }

  public getLightingState(): {
    ambientColor: string;
    skyColor: string;
    daylight: number;
    cloudCover: number;
  } {
    return {
      ambientColor: `#${this.ambientColor.getHexString()}`,
      skyColor: `#${this.backgroundColor.getHexString()}`,
      daylight: this.currentDaylight,
      cloudCover: this.field.cloudCover,
    };
  }

  /**
   * 当前混合出的连续天气场量。昼夜系统按它决定日月被云遮住多少、星空能亮
   * 到什么程度；返回的是复用对象，调用方只读不持有。
   */
  public getWeatherField(): Readonly<WeatherFieldState> {
    return this.field;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.activeChunks.clear();
    this.activeChunkOrder = [];
    this.visuals.dispose();
    // 共享墨线是跨场景的模块级材质，卸载时恢复基准色。
    resetEnvironmentInk();
  }

  private syncActiveChunks(worldX: number, worldZ: number): void {
    const centerX = toChunkCoordinate(worldX);
    const centerZ = toChunkCoordinate(worldZ);
    if (centerX === this.focusChunkX && centerZ === this.focusChunkZ) return;
    this.focusChunkX = centerX;
    this.focusChunkZ = centerZ;

    const desired = listChunksInRadius(centerX, centerZ, WEATHER_CHUNK_RADIUS);
    const desiredKeys = new Set(desired.map((chunk) => chunk.key));
    for (const key of this.activeChunks.keys()) {
      if (!desiredKeys.has(key)) this.activeChunks.delete(key);
    }
    for (const chunk of desired) {
      if (!this.activeChunks.has(chunk.key)) {
        this.activeChunks.set(
          chunk.key,
          this.createWeatherChunk(chunk.chunkX, chunk.chunkZ),
        );
      }
    }
    this.activeChunkOrder = desired
      .map((chunk) => this.activeChunks.get(chunk.key))
      .filter((chunk): chunk is WeatherChunk => Boolean(chunk));
  }

  private createWeatherChunk(chunkX: number, chunkZ: number): WeatherChunk {
    return {
      key: toChunkKey(chunkX, chunkZ),
      random: createRandom(createChunkSeed(chunkX, chunkZ)),
    };
  }

  private precipitationRandom(focusX: number, focusZ: number): () => number {
    const key = toChunkKey(toChunkCoordinate(focusX), toChunkCoordinate(focusZ));
    return this.activeChunks.get(key)?.random ?? this.random;
  }

  private createRainDrop(focusX: number, focusZ: number, respawning: boolean): RainDrop {
    const random = this.precipitationRandom(focusX, focusZ);
    const x = focusX + (random() * 2 - 1) * PRECIPITATION_WINDOW_HALF_SIZE;
    const z = focusZ + (random() * 2 - 1) * PRECIPITATION_WINDOW_HALF_SIZE;
    const groundY = this.safeGroundHeight(x, z);
    return {
      x,
      y: groundY + (respawning
        ? PRECIPITATION_RESPAWN_MINIMUM_HEIGHT
          + random() * PRECIPITATION_RESPAWN_HEIGHT_RANGE
        : random() * (
          PRECIPITATION_RESPAWN_MINIMUM_HEIGHT + PRECIPITATION_RESPAWN_HEIGHT_RANGE
        )),
      z,
      groundY,
      speed: 9 + random() * 4,
      groundProbePending: true,
    };
  }

  private resetRainDrop(drop: RainDrop, focusX = this.focusX, focusZ = this.focusZ): void {
    const replacement = this.createRainDrop(focusX, focusZ, true);
    drop.x = replacement.x;
    drop.y = replacement.y;
    drop.z = replacement.z;
    drop.groundY = replacement.groundY;
    drop.speed = replacement.speed;
    drop.groundProbePending = replacement.groundProbePending;
  }

  /**
   * 小范围移动保留雨点的绝对世界坐标，只把落到滑动窗口外的槽位重投放；
   * 快速传送也只重置固定 560 个对象，不沿路径补算、不扫描世界 Chunk。
   */
  private syncRainWindow(focusX: number, focusZ: number): void {
    for (const drop of this.rainDrops) {
      if (
        Math.abs(drop.x - focusX) <= PRECIPITATION_WINDOW_HALF_SIZE
        && Math.abs(drop.z - focusZ) <= PRECIPITATION_WINDOW_HALF_SIZE
      ) continue;
      this.resetRainDrop(drop, focusX, focusZ);
    }
  }

  private createSnowFlake(focusX: number, focusZ: number, respawning: boolean): SnowFlake {
    const random = this.precipitationRandom(focusX, focusZ);
    const x = focusX + (random() * 2 - 1) * PRECIPITATION_WINDOW_HALF_SIZE;
    const z = focusZ + (random() * 2 - 1) * PRECIPITATION_WINDOW_HALF_SIZE;
    const groundY = this.safeGroundHeight(x, z);
    return {
      x,
      y: groundY + (respawning
        ? PRECIPITATION_RESPAWN_MINIMUM_HEIGHT
          + random() * PRECIPITATION_RESPAWN_HEIGHT_RANGE
        : random() * (
          PRECIPITATION_RESPAWN_MINIMUM_HEIGHT + PRECIPITATION_RESPAWN_HEIGHT_RANGE
        )),
      z,
      groundY,
      speed: 0.6 + random() * 0.5,
      phase: random() * Math.PI * 2,
      amplitude: 0.35 + random() * 0.4,
      frequency: 0.5 + random() * 0.7,
      rotation: random() * Math.PI * 2,
      rotationSpeed: (random() - 0.5) * 2,
    };
  }

  private resetSnowFlake(flake: SnowFlake, focusX = this.focusX, focusZ = this.focusZ): void {
    const replacement = this.createSnowFlake(focusX, focusZ, true);
    Object.assign(flake, replacement);
  }

  private syncSnowWindow(focusX: number, focusZ: number): void {
    for (const flake of this.snowFlakes) {
      if (
        Math.abs(flake.x - focusX) <= PRECIPITATION_WINDOW_HALF_SIZE
        && Math.abs(flake.z - focusZ) <= PRECIPITATION_WINDOW_HALF_SIZE
      ) continue;
      this.resetSnowFlake(flake, focusX, focusZ);
    }
  }

  private safeGroundHeight(x: number, z: number): number {
    const height = this.sampleGroundHeight(x, z);
    return Number.isFinite(height) ? height : 0;
  }

  /**
   * 合成这一帧的场景环境。
   *
   * 天空底色、环境光和主光方向来自昼夜系统，天气只在它上面叠加云量压灰、
   * 雾浓度和雷闪。全场景唯一的一次写入在这里完成——背景、雾和共享 uniform
   * 如果被两套系统各写一遍，就会在同一帧里互相覆盖。
   */
  private updateEnvironment(deltaSeconds: number): void {
    const sky = this.sky?.getSkyState();
    const skyColor = sky ? sky.skyColor : this.baseBackground;
    grayscale(skyColor, this.grayColor);
    this.backgroundColor.copy(skyColor).lerp(
      this.grayColor,
      clamp01(this.state.gray) * 0.75,
    );
    const lightningFlash = this.currentLightningFlash;
    if (lightningFlash > 0) {
      this.backgroundColor.lerp(this.lightningColor, lightningFlash * 0.4);
    }
    this.scene.background = this.backgroundColor;

    const fog = this.scene.fog instanceof THREE.Fog
      ? this.scene.fog
      : new THREE.Fog(this.baseFogColor, this.baseFogNear, this.baseFogFar);
    // 雾跟着天空走，远景才会融进当前时刻的天色；作者写下的雾色偏移原样保留。
    this.fogColor.setRGB(
      clamp01(this.backgroundColor.r + this.fogColorOffset.r),
      clamp01(this.backgroundColor.g + this.fogColorOffset.g),
      clamp01(this.backgroundColor.b + this.fogColorOffset.b),
    );
    fog.color.copy(this.fogColor);
    const denseNear = Math.min(3, this.baseFogNear);
    const denseFar = Math.max(denseNear + 1, Math.min(24, this.baseFogFar));
    fog.near = lerp(this.baseFogNear, denseNear, this.state.fog);
    fog.far = lerp(this.baseFogFar, denseFar, this.state.fog);
    this.scene.fog = fog;

    const cloudCover = this.field.cloudCover;
    this.currentDaylight = clamp01(
      (sky ? sky.dayFactor : 1)
        * (1 - cloudCover * 0.72 - this.state.fog * 0.18),
    );
    const ambientMix = clamp01(this.state.gray * 0.52 + cloudCover * 0.1);
    const ambientBrightness = Math.max(
      0.55,
      1 - this.state.gray * 0.28 - cloudCover * 0.06,
    );
    this.ambientColor.copy(sky ? sky.ambientColor : NEUTRAL_AMBIENT_COLOR)
      .lerp(this.stormAmbientColor, ambientMix)
      .multiplyScalar(ambientBrightness * (sky ? sky.ambientBrightness : 1));
    if (lightningFlash > 0) this.ambientColor.lerp(this.lightningColor, lightningFlash * 0.55);

    // 朝太阳看的那一侧雾被日光染暖；云越厚，透过来的直射光越少。
    const scatterStrength = (sky ? sky.scatterStrength : 0)
      * (1 - cloudCover * 0.7)
      * (1 - clamp01(this.state.fog) * 0.35);
    this.scatterColor.copy(sky ? sky.scatterColor : this.fogColor)
      .lerp(this.fogColor, clamp01(this.state.gray) * 0.5);

    // 云影跟着风漂：偏移按秒累积，帧率变化不会改变漂移速度。
    const windSpeed = 0.35 + this.state.wind * 0.5;
    this.cloudShadowOffsetX += WIND_X * windSpeed * deltaSeconds * 0.02;
    this.cloudShadowOffsetZ += WIND_Z * windSpeed * deltaSeconds * 0.02;
    // 只有白天的直射光才投得出云影；夜里和暴雨的漫射光下没有清晰的影子。
    const cloudShadowStrength = clamp01(cloudCover * 1.35 - 0.25)
      * clamp01((sky ? sky.directLight : 1) * 1.2)
      * (1 - clamp01(this.state.fog) * 0.6)
      * 0.42;

    this.updateEnvironmentRuntime(fog, sky, scatterStrength, cloudShadowStrength);
    this.updateCloudMaterials(deltaSeconds, sky);
  }

  /**
   * 把合成好的环境写进整帧共用的状态。
   *
   * 共享 uniform、共享墨线材质和共享接触阴影 uniform 都只在这里写一次；
   * 它们是全场景一份的，两个系统各写一遍就会在同一帧里互相覆盖。
   */
  private updateEnvironmentRuntime(
    fog: THREE.Fog,
    sky: Readonly<SkyState> | undefined,
    scatterStrength: number,
    cloudShadowStrength: number,
  ): void {
    // 墨线跟着环境光换色相；浓度则跟着照度走：纸面沉下去时墨要浮上来。
    normalizeTint(this.ambientColor, INK_TINT_STRENGTH, this.tintColor);
    applyEnvironmentInk(this.tintColor, luminance(this.ambientColor));

    // 接触阴影跟着主光走：太阳低就拉长，云厚或入夜就化开。
    if (sky) CONTACT_SHADOW_UNIFORMS.uSunDirection.value.copy(sky.sunDirection);
    CONTACT_SHADOW_UNIFORMS.uShadowStrength.value = clamp01(
      (sky ? sky.directLight : 1) * (1 - this.field.cloudCover * 0.75),
    );
    CONTACT_SHADOW_UNIFORMS.uShadowTint.value.copy(this.tintColor);

    const runtime = this.runtime;
    if (!runtime) return;
    runtime.fogColor.value.copy(this.fogColor);
    runtime.fogNear.value = fog.near;
    runtime.fogFar.value = fog.far;
    runtime.ambientColor.value.copy(this.ambientColor);
    runtime.daylight.value = this.currentDaylight;
    if (sky) runtime.sunDirection.value.copy(sky.sunDirection);
    runtime.inkTint.value.copy(this.tintColor);
    // 半球染色：朝天的面取当前天色，朝下的面取地面反弹色。
    normalizeTint(this.backgroundColor, SKY_TINT_STRENGTH, runtime.skyTint.value);
    normalizeTint(this.baseBounceColor, BOUNCE_TINT_STRENGTH, runtime.bounceTint.value);
    runtime.scatterColor.value.copy(this.scatterColor);
    runtime.scatterStrength.value = clamp01(scatterStrength);
    runtime.cloudShadowStrength.value = cloudShadowStrength;
    runtime.cloudShadowOffset.value.set(this.cloudShadowOffsetX, this.cloudShadowOffsetZ);
  }

  /** 云的受光面取当前日光色，背光面取天色，日落的云因此会朝太阳一侧亮起来。 */
  private updateCloudMaterials(
    deltaSeconds: number,
    sky: Readonly<SkyState> | undefined,
  ): void {
    const fade = Math.min(1, deltaSeconds * 2);
    const uniforms = this.visuals.cloudFillUniforms;
    uniforms.uOpacity.value = lerp(
      uniforms.uOpacity.value,
      0.88 - this.state.gray * 0.22,
      fade,
    );
    if (sky) uniforms.uSunDirection.value.copy(sky.sunDirection);

    this.cloudColor.setHex(0xffffff).lerp(
      this.stormCloudColor,
      clamp01(this.state.gray * 1.15),
    );
    // 受光面吸收日光的暖色，背光面压向天色，两者都还带着当前的环境亮度。
    this.cloudLitColor.copy(this.cloudColor);
    if (sky) {
      this.cloudLitColor.lerp(this.scatterColor, clamp01(sky.scatterStrength) * 0.7);
      this.cloudLitColor.multiplyScalar(0.35 + 0.65 * clamp01(sky.dayFactor + sky.moonlit));
    }
    uniforms.uLitColor.value.copy(this.cloudLitColor);
    uniforms.uShadowColor.value.copy(this.cloudColor)
      .multiplyScalar(0.72)
      .lerp(this.backgroundColor, 0.35);
    this.visuals.cloudLineMaterial.color.copy(this.cloudLitColor).multiplyScalar(0.58);
  }

  /** 把这一帧混合出的连续状态写进复用快照，供昼夜系统在下一帧读取。 */
  private publishWeatherField(): void {
    this.field.clouds = this.state.clouds;
    this.field.cloudCover = clamp01(this.state.clouds / 10);
    this.field.rain = this.state.rain;
    this.field.snow = this.state.snow;
    this.field.fog = this.state.fog;
    this.field.gray = this.state.gray;
    this.field.wind = this.state.wind;
    this.field.lightningFlash = this.currentLightningFlash;
  }

  private updateClouds(deltaSeconds: number, elapsedSeconds: number): void {
    const wanted = Math.round(this.state.clouds);
    const cloudSpeed = 0.3 + this.state.wind * 0.45;
    for (let index = 0; index < this.visuals.clouds.length; index += 1) {
      const cloud = this.visuals.clouds[index];
      const targetOpacity = index < wanted ? 1 : 0;
      const opacity = lerp(
        this.cloudOpacities[index],
        targetOpacity,
        Math.min(1, deltaSeconds * 0.9),
      );
      this.cloudOpacities[index] = opacity;
      cloud.root.visible = opacity > 0.02;
      cloud.root.scale.setScalar(opacity * 0.68);
      if (!cloud.root.visible) continue;
      cloud.root.position.x += WIND_X * cloudSpeed * cloud.speed * deltaSeconds;
      cloud.root.position.z += WIND_Z * cloudSpeed * cloud.speed * deltaSeconds;
      cloud.root.position.y += Math.sin(elapsedSeconds * 0.5 + cloud.floatPhase) * 0.002;
      cloud.root.position.x = wrapAround(
        cloud.root.position.x,
        this.focusX,
        CLOUD_WRAP_HALF_SIZE,
      );
      cloud.root.position.z = wrapAround(
        cloud.root.position.z,
        this.focusZ,
        CLOUD_WRAP_HALF_SIZE,
      );
    }
  }

  private updateRain(deltaSeconds: number): void {
    const wantedRainCount = Math.min(
      WEATHER_VISUAL_CAPACITY.rainDrops,
      Math.round(this.state.rain),
    );
    const speedMultiplier = 1 + this.state.wind * 0.35;
    const drift = this.state.wind * 5.5;
    const lineLength = 0.42 + this.state.wind * 0.28;
    let offset = 0;
    let rainCount = 0;
    for (let index = 0; index < wantedRainCount; index += 1) {
      const drop = this.rainDrops[index];
      drop.y -= drop.speed * speedMultiplier * deltaSeconds;
      drop.x += WIND_X * drift * deltaSeconds;
      drop.z += WIND_Z * drift * deltaSeconds;
      let velocityX = WIND_X * drift;
      let velocityY = -drop.speed * speedMultiplier;
      let velocityZ = WIND_Z * drift;
      let lengthScale = lineLength / Math.hypot(velocityX, velocityY, velocityZ);
      const outsideWindow = (
        Math.abs(drop.x - this.focusX) > PRECIPITATION_WINDOW_HALF_SIZE
        || Math.abs(drop.z - this.focusZ) > PRECIPITATION_WINDOW_HALF_SIZE
      );

      if (outsideWindow) {
        // 窗口回收不是落地，不能生成远处水花。
        this.resetRainDrop(drop);
      } else {
        // 出生高度用于快速下降；仅在接近地面时按当前 x/z 再采样一次，
        // 修正风造成的水平位移以及运行时地形编辑。
        if (drop.groundProbePending && drop.y - drop.groundY <= RAIN_GROUND_PROBE_HEIGHT) {
          drop.groundY = this.safeGroundHeight(drop.x, drop.z);
          drop.groundProbePending = false;
        }
        const tailY = drop.y + velocityY * lengthScale;
        if (tailY <= drop.groundY) {
          this.spawnRainSplash(drop.x, drop.groundY, drop.z);
          this.resetRainDrop(drop);
        }
      }

      // 重投放后速度会变化，重新计算线尾，避免第一帧沿用旧雨滴长度。
      velocityX = WIND_X * drift;
      velocityY = -drop.speed * speedMultiplier;
      velocityZ = WIND_Z * drift;
      lengthScale = lineLength / Math.hypot(velocityX, velocityY, velocityZ);
      this.visuals.rainPositions[offset++] = drop.x;
      this.visuals.rainPositions[offset++] = drop.y;
      this.visuals.rainPositions[offset++] = drop.z;
      this.visuals.rainPositions[offset++] = drop.x + velocityX * lengthScale;
      this.visuals.rainPositions[offset++] = drop.y + velocityY * lengthScale;
      this.visuals.rainPositions[offset++] = drop.z + velocityZ * lengthScale;
      rainCount += 1;
    }
    this.visibleRainCount = rainCount;
    this.visuals.rainLines.visible = rainCount > 0;
    this.visuals.rainGeometry.setDrawRange(0, rainCount * 2);
    if (rainCount === 0) return;
    this.visuals.rainGeometry.getAttribute('position').needsUpdate = true;
    this.visuals.rainMaterial.opacity = 0.58 + 0.22 * Math.min(1, this.state.rain / 300);
  }

  private spawnRainSplash(x: number, groundY: number, z: number): void {
    const splash = this.rainSplashes[this.rainSplashCursor];
    this.rainSplashCursor = (
      this.rainSplashCursor + 1
    ) % WEATHER_VISUAL_CAPACITY.rainSplashes;
    splash.x = x;
    splash.y = groundY + 0.025;
    splash.z = z;
    splash.age = 0;
    splash.lifetime = RAIN_SPLASH_LIFETIME_MINIMUM
      + this.random() * RAIN_SPLASH_LIFETIME_RANGE;
    splash.active = true;
  }

  /**
   * 把固定池中的有效水花压紧写入一个动态顶点缓冲。每个效果只有 12 条线，
   * 不做射线、不建临时 Mesh，也不会因暴雨增加 Object3D 数量。
   */
  private updateRainSplashes(deltaSeconds: number): void {
    let offset = 0;
    let splashCount = 0;
    for (const splash of this.rainSplashes) {
      if (!splash.active) continue;
      splash.age += deltaSeconds;
      if (splash.age >= splash.lifetime) {
        splash.active = false;
        continue;
      }

      const progress = splash.age / splash.lifetime;
      const radius = 0.045 + progress * 0.24;
      const ringY = splash.y + Math.sin(progress * Math.PI) * 0.018;
      for (let segment = 0; segment < 8; segment += 1) {
        const angleA = segment * Math.PI / 4;
        const angleB = (segment + 1) * Math.PI / 4;
        this.visuals.rainSplashPositions[offset++] = splash.x + Math.cos(angleA) * radius;
        this.visuals.rainSplashPositions[offset++] = ringY;
        this.visuals.rainSplashPositions[offset++] = splash.z + Math.sin(angleA) * radius;
        this.visuals.rainSplashPositions[offset++] = splash.x + Math.cos(angleB) * radius;
        this.visuals.rainSplashPositions[offset++] = ringY;
        this.visuals.rainSplashPositions[offset++] = splash.z + Math.sin(angleB) * radius;
      }

      const crownRadius = radius * 0.62;
      const crownHeight = Math.sin(progress * Math.PI) * 0.16;
      for (let ray = 0; ray < 4; ray += 1) {
        const angle = ray * Math.PI / 2 + Math.PI / 4;
        const directionX = Math.cos(angle);
        const directionZ = Math.sin(angle);
        this.visuals.rainSplashPositions[offset++] = splash.x + directionX * radius * 0.16;
        this.visuals.rainSplashPositions[offset++] = splash.y;
        this.visuals.rainSplashPositions[offset++] = splash.z + directionZ * radius * 0.16;
        this.visuals.rainSplashPositions[offset++] = splash.x + directionX * crownRadius;
        this.visuals.rainSplashPositions[offset++] = splash.y + crownHeight;
        this.visuals.rainSplashPositions[offset++] = splash.z + directionZ * crownRadius;
      }
      splashCount += 1;
    }

    this.visibleRainSplashCount = splashCount;
    this.visuals.rainSplashLines.visible = splashCount > 0;
    this.visuals.rainSplashGeometry.setDrawRange(
      0,
      splashCount * RAIN_SPLASH_SEGMENTS_PER_EFFECT * 2,
    );
    if (splashCount > 0) {
      this.visuals.rainSplashGeometry.getAttribute('position').needsUpdate = true;
    }
  }

  private updateSnow(deltaSeconds: number, elapsedSeconds: number): void {
    const wantedSnowCount = Math.min(
      WEATHER_VISUAL_CAPACITY.snowFlakes,
      Math.round(this.state.snow),
    );
    const arm = 0.085;
    const drift = this.state.wind * 3.2;
    let offset = 0;
    let snowCount = 0;
    for (let index = 0; index < wantedSnowCount; index += 1) {
      const flake = this.snowFlakes[index];
      flake.y -= flake.speed * (1 + this.state.wind * 1.3) * deltaSeconds;
      flake.x += (
        Math.sin(elapsedSeconds * flake.frequency + flake.phase) * flake.amplitude
        + WIND_X * drift
      ) * deltaSeconds;
      flake.z += (
        Math.cos(elapsedSeconds * flake.frequency * 0.8 + flake.phase)
          * flake.amplitude * 0.6
        + WIND_Z * drift
      ) * deltaSeconds;
      flake.rotation += flake.rotationSpeed * deltaSeconds;
      if (
        flake.y < flake.groundY
        || Math.abs(flake.x - this.focusX) > PRECIPITATION_WINDOW_HALF_SIZE
        || Math.abs(flake.z - this.focusZ) > PRECIPITATION_WINDOW_HALF_SIZE
      ) this.resetSnowFlake(flake);

      for (let armIndex = 0; armIndex < 3; armIndex += 1) {
        const angle = flake.rotation + armIndex * Math.PI / 3;
        const dx = Math.cos(angle) * arm;
        const dy = Math.sin(angle) * arm;
        this.visuals.snowPositions[offset++] = flake.x - dx;
        this.visuals.snowPositions[offset++] = flake.y - dy;
        this.visuals.snowPositions[offset++] = flake.z;
        this.visuals.snowPositions[offset++] = flake.x + dx;
        this.visuals.snowPositions[offset++] = flake.y + dy;
        this.visuals.snowPositions[offset++] = flake.z;
      }
      snowCount += 1;
    }
    this.visibleSnowCount = snowCount;
    this.visuals.snowLines.visible = snowCount > 0;
    this.visuals.snowGeometry.setDrawRange(0, snowCount * 6);
    if (snowCount === 0) return;
    this.visuals.snowGeometry.getAttribute('position').needsUpdate = true;
  }

  private updateLightning(deltaSeconds: number): void {
    if (this.weatherType === 'storm' && this.state.rain > 260) {
      this.nextLightningSeconds -= deltaSeconds;
      if (this.nextLightningSeconds <= 0) this.spawnLightning();
    }
    if (this.lightningRemaining <= 0) {
      this.currentLightningFlash = 0;
      return;
    }
    // 闪光既照亮天空也照亮地面，所以强度算一次、天空与环境光共用。
    this.currentLightningFlash = Math.max(0, Math.sin(this.lightningRemaining * 34))
      * Math.min(1, this.lightningRemaining / 0.45);
    this.lightningRemaining -= deltaSeconds;
    const strength = Math.max(0, this.lightningRemaining / 0.45);
    this.visuals.lightningMaterial.opacity = strength;
    if (this.lightningRemaining <= 0) {
      this.currentLightningFlash = 0;
      this.visuals.lightningLine.visible = false;
      this.visuals.lightningMaterial.opacity = 0;
    }
  }

  private spawnLightning(): void {
    const startX = this.focusX + (this.random() - 0.5) * CHUNK_SIZE * 0.7;
    const startZ = this.focusZ + (this.random() - 0.5) * CHUNK_SIZE * 0.7;
    const groundY = this.safeGroundHeight(startX, startZ);
    for (let point = 0; point < 8; point += 1) {
      const amount = point / 7;
      this.visuals.lightningPositions[point * 3] = startX
        + (this.random() - 0.5) * amount * 2;
      this.visuals.lightningPositions[point * 3 + 1] = groundY
        + PRECIPITATION_HEIGHT * (1 - amount);
      this.visuals.lightningPositions[point * 3 + 2] = startZ
        + (this.random() - 0.5) * amount * 2;
    }
    this.visuals.lightningGeometry.getAttribute('position').needsUpdate = true;
    this.visuals.lightningLine.visible = true;
    this.lightningRemaining = 0.45;
    this.nextLightningSeconds = 6 + this.random() * 14;
  }
}
