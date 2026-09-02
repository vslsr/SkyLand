import * as THREE from 'three';
import {
  listChunksInRadius,
  toChunkCoordinate,
  toChunkKey,
} from '../../shared/world/chunkKey.mjs';
import { CHUNK_SIZE } from '../../shared/world/worldConfig.mjs';
import type {
  SkyStateSource,
  WeatherFieldSource,
  WeatherFieldState,
} from '../environment/EnvironmentTypes';
import type { SceneEnvironmentRuntime } from '../materials/createFillMaterial';
import {
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
  readonly chunkX: number;
  readonly chunkZ: number;
  readonly originX: number;
  readonly originZ: number;
  readonly random: () => number;
  readonly rainDrops: RainDrop[];
  readonly snowFlakes: SnowFlake[];
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
const CLOUD_WRAP_HALF_SIZE = 70;
const WIND_X = 0.86;
const WIND_Z = 0.51;
const TRANSITION_SPEED = 0.55;

/** 没有昼夜系统时的中性白光。 */
const NEUTRAL_AMBIENT_COLOR = new THREE.Color(0xffffff);

export const WEATHER_PARTICLE_LIMITS = Object.freeze({
  chunkSize: CHUNK_SIZE,
  activationRadius: WEATHER_CHUNK_RADIUS,
  maximumActiveChunks: MAXIMUM_ACTIVE_CHUNKS,
  rainDropsPerChunk: WEATHER_VISUAL_CAPACITY.rainDropsPerChunk,
  snowFlakesPerChunk: WEATHER_VISUAL_CAPACITY.snowFlakesPerChunk,
  rainDrops: WEATHER_VISUAL_CAPACITY.rainDrops,
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
  const luminance = color.r * 0.3 + color.g * 0.59 + color.b * 0.11;
  return out.setScalar(luminance * 0.9 + 0.08);
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
  private readonly baseFogNear: number;
  private readonly baseFogFar: number;
  private readonly activeChunks = new Map<string, WeatherChunk>();
  private activeChunkOrder: WeatherChunk[] = [];
  private readonly cloudOpacities = new Float32Array(WEATHER_VISUAL_CAPACITY.clouds);
  private readonly random = createRandom(0x79a3_5f21);
  private readonly backgroundColor = new THREE.Color();
  private readonly fogColor = new THREE.Color();
  private readonly grayColor = new THREE.Color();
  private readonly cloudColor = new THREE.Color();
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
    this.baseFogNear = environment.fogNear;
    this.baseFogFar = environment.fogFar;
    this.syncActiveChunks(0, 0);
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
    this.updateSnow(dt, elapsedSeconds);
  }

  public getParticleCounts(): { rain: number; snow: number } {
    return { rain: this.visibleRainCount, snow: this.visibleSnowCount };
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
    const random = createRandom(createChunkSeed(chunkX, chunkZ));
    const chunk: WeatherChunk = {
      key: toChunkKey(chunkX, chunkZ),
      chunkX,
      chunkZ,
      originX: chunkX * CHUNK_SIZE,
      originZ: chunkZ * CHUNK_SIZE,
      random,
      rainDrops: [],
      snowFlakes: [],
    };
    for (let index = 0; index < WEATHER_VISUAL_CAPACITY.rainDropsPerChunk; index += 1) {
      chunk.rainDrops.push(this.createRainDrop(chunk));
    }
    for (let index = 0; index < WEATHER_VISUAL_CAPACITY.snowFlakesPerChunk; index += 1) {
      chunk.snowFlakes.push(this.createSnowFlake(chunk));
    }
    return chunk;
  }

  private createRainDrop(chunk: WeatherChunk): RainDrop {
    const x = chunk.random() * CHUNK_SIZE;
    const z = chunk.random() * CHUNK_SIZE;
    const groundY = this.safeGroundHeight(chunk.originX + x, chunk.originZ + z);
    return {
      x,
      y: groundY + chunk.random() * PRECIPITATION_HEIGHT,
      z,
      groundY,
      speed: 9 + chunk.random() * 4,
    };
  }

  private resetRainDrop(drop: RainDrop, chunk: WeatherChunk): void {
    drop.x = chunk.random() * CHUNK_SIZE;
    drop.z = chunk.random() * CHUNK_SIZE;
    drop.groundY = this.safeGroundHeight(
      chunk.originX + drop.x,
      chunk.originZ + drop.z,
    );
    drop.y = drop.groundY + PRECIPITATION_HEIGHT * (0.78 + chunk.random() * 0.22);
  }

  private createSnowFlake(chunk: WeatherChunk): SnowFlake {
    const x = chunk.random() * CHUNK_SIZE;
    const z = chunk.random() * CHUNK_SIZE;
    const groundY = this.safeGroundHeight(chunk.originX + x, chunk.originZ + z);
    return {
      x,
      y: groundY + chunk.random() * PRECIPITATION_HEIGHT,
      z,
      groundY,
      speed: 0.6 + chunk.random() * 0.5,
      phase: chunk.random() * Math.PI * 2,
      amplitude: 0.35 + chunk.random() * 0.4,
      frequency: 0.5 + chunk.random() * 0.7,
      rotation: chunk.random() * Math.PI * 2,
      rotationSpeed: (chunk.random() - 0.5) * 2,
    };
  }

  private resetSnowFlake(flake: SnowFlake, chunk: WeatherChunk): void {
    flake.x = chunk.random() * CHUNK_SIZE;
    flake.z = chunk.random() * CHUNK_SIZE;
    flake.groundY = this.safeGroundHeight(
      chunk.originX + flake.x,
      chunk.originZ + flake.z,
    );
    flake.y = flake.groundY
      + PRECIPITATION_HEIGHT * (0.78 + chunk.random() * 0.22);
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

    if (this.runtime) {
      this.runtime.fogColor.value.copy(this.fogColor);
      this.runtime.fogNear.value = fog.near;
      this.runtime.fogFar.value = fog.far;
      this.runtime.ambientColor.value.copy(this.ambientColor);
      this.runtime.daylight.value = this.currentDaylight;
      if (sky) this.runtime.sunDirection.value.copy(sky.sunDirection);
    }

    const fade = Math.min(1, deltaSeconds * 2);
    this.visuals.cloudFillMaterial.opacity = lerp(
      this.visuals.cloudFillMaterial.opacity,
      0.88 - this.state.gray * 0.22,
      fade,
    );
    this.cloudColor.setHex(0xffffff).lerp(
      this.stormCloudColor,
      clamp01(this.state.gray * 1.15),
    );
    this.visuals.cloudFillMaterial.color.copy(this.cloudColor);
    this.visuals.cloudLineMaterial.color.copy(this.cloudColor).multiplyScalar(0.58);
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
    const rainPerChunk = Math.min(
      WEATHER_VISUAL_CAPACITY.rainDropsPerChunk,
      Math.round(this.state.rain / MAXIMUM_ACTIVE_CHUNKS),
    );
    const speedMultiplier = 1 + this.state.wind * 0.35;
    const drift = this.state.wind * 5.5;
    const lineLength = 0.42 + this.state.wind * 0.28;
    let offset = 0;
    let rainCount = 0;
    for (const chunk of this.activeChunkOrder) {
      for (let index = 0; index < rainPerChunk; index += 1) {
        const drop = chunk.rainDrops[index];
        drop.y -= drop.speed * speedMultiplier * deltaSeconds;
        drop.x += WIND_X * drift * deltaSeconds;
        drop.z += WIND_Z * drift * deltaSeconds;
        if (
          drop.y < drop.groundY
          || drop.x < 0
          || drop.x >= CHUNK_SIZE
          || drop.z < 0
          || drop.z >= CHUNK_SIZE
        ) this.resetRainDrop(drop, chunk);

        const velocityX = WIND_X * drift;
        const velocityY = -drop.speed * speedMultiplier;
        const velocityZ = WIND_Z * drift;
        const lengthScale = lineLength / Math.hypot(velocityX, velocityY, velocityZ);
        const worldX = chunk.originX + drop.x;
        const worldZ = chunk.originZ + drop.z;
        this.visuals.rainPositions[offset++] = worldX;
        this.visuals.rainPositions[offset++] = drop.y;
        this.visuals.rainPositions[offset++] = worldZ;
        this.visuals.rainPositions[offset++] = worldX + velocityX * lengthScale;
        this.visuals.rainPositions[offset++] = drop.y + velocityY * lengthScale;
        this.visuals.rainPositions[offset++] = worldZ + velocityZ * lengthScale;
        rainCount += 1;
      }
    }
    this.visibleRainCount = rainCount;
    this.visuals.rainLines.visible = rainCount > 0;
    this.visuals.rainGeometry.setDrawRange(0, rainCount * 2);
    if (rainCount === 0) return;
    this.visuals.rainGeometry.getAttribute('position').needsUpdate = true;
    this.visuals.rainMaterial.opacity = 0.35 + 0.25 * Math.min(1, this.state.rain / 300);
  }

  private updateSnow(deltaSeconds: number, elapsedSeconds: number): void {
    const snowPerChunk = Math.min(
      WEATHER_VISUAL_CAPACITY.snowFlakesPerChunk,
      Math.round(this.state.snow / MAXIMUM_ACTIVE_CHUNKS),
    );
    const arm = 0.085;
    const drift = this.state.wind * 3.2;
    let offset = 0;
    let snowCount = 0;
    for (const chunk of this.activeChunkOrder) {
      for (let index = 0; index < snowPerChunk; index += 1) {
        const flake = chunk.snowFlakes[index];
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
          || flake.x < 0
          || flake.x >= CHUNK_SIZE
          || flake.z < 0
          || flake.z >= CHUNK_SIZE
        ) this.resetSnowFlake(flake, chunk);

        const worldX = chunk.originX + flake.x;
        const worldZ = chunk.originZ + flake.z;
        for (let armIndex = 0; armIndex < 3; armIndex += 1) {
          const angle = flake.rotation + armIndex * Math.PI / 3;
          const dx = Math.cos(angle) * arm;
          const dy = Math.sin(angle) * arm;
          this.visuals.snowPositions[offset++] = worldX - dx;
          this.visuals.snowPositions[offset++] = flake.y - dy;
          this.visuals.snowPositions[offset++] = worldZ;
          this.visuals.snowPositions[offset++] = worldX + dx;
          this.visuals.snowPositions[offset++] = flake.y + dy;
          this.visuals.snowPositions[offset++] = worldZ;
        }
        snowCount += 1;
      }
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
