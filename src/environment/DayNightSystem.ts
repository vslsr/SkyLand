import * as THREE from 'three';
import {
  CELESTIAL_RADIUS,
  CELESTIAL_VISUAL_CAPACITY,
  createCelestialVisuals,
} from '../models/sky/createCelestialVisuals';
import type { SceneDayNightDefinition } from '../scenes/data/SceneDefinition';
import type { SceneVisualSystem } from '../scene/SceneVisualSystem';
import type {
  DayNightVisualTarget,
  SkyState,
  SkyStateSource,
  WeatherFieldSource,
} from './EnvironmentTypes';
import {
  clamp01,
  moonAngle,
  nightFactor,
  sampleSkyColor,
  skyDarkness,
  sunAngle,
  twilightFactor,
} from './skyGradient';

export interface DayNightEnvironmentDefinition {
  /** 场景自己的纸面背景色；白昼段的天空就是它。 */
  backgroundColor: THREE.ColorRepresentation;
  /** 场景地面色；决定半球光里从下方反弹回来的那一半是什么色相。 */
  groundColor?: THREE.ColorRepresentation;
  /** 服务端净化过的昼夜配置，提供初始时刻与推进速率。 */
  dayNight: SceneDayNightDefinition;
}

interface MeteorState {
  active: boolean;
  elapsed: number;
  life: number;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
}

/** 日轮/月轮升到这个高度（占天球半径的比例）之上就完全显形。 */
const HORIZON_FADE_HEIGHT = 0.1;

/** 天球贴着相机远裁剪面留出的余量；再远一点就会被裁掉。 */
const DOME_FAR_PLANE_MARGIN = 0.92;

const STAR_FADE_SPEED = 2;
const STAR_ROTATION_SPEED = 0.004;
const METEOR_MINIMUM_INTERVAL = 3.5;
const METEOR_INTERVAL_RANGE = 7.5;
/** 星空至少要亮到这个程度才值得放流星。 */
const METEOR_STAR_THRESHOLD = 0.25;

const NIGHT_AMBIENT_COLOR = new THREE.Color(0x2b3450);
const MOON_AMBIENT_COLOR = new THREE.Color(0x6c7c96);
const WARM_AMBIENT_COLOR = new THREE.Color(0xffd9a0);
const EMBER_AMBIENT_COLOR = new THREE.Color(0xff9e7e);
/** 高日角时的散射色：接近日轮本身的浅金色。 */
const HIGH_SUN_SCATTER_COLOR = new THREE.Color(0xffe6b8);
/** 贴地日角时的散射色：日出日落被大气拉长后的橙红。 */
const LOW_SUN_SCATTER_COLOR = new THREE.Color(0xff8a4c);

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function smoothstep01(value: number): number {
  const clamped = clamp01(value);
  return clamped * clamped * (3 - 2 * clamped);
}

/**
 * 客户端昼夜表现。
 *
 * 服务端只同步「现在几点」和「一天走多少真实秒」；日轮与月轮的轨迹、天空
 * 渐变、环境光配色、星空亮度和流星全部由这里按同一份时刻本地推导，所以
 * 每个客户端看到的昼夜是一致的，而网络上不需要多传一个字节的表现参数。
 *
 * 天空底色与环境光只在这里算出来，最终写进场景背景、雾和共享 uniform 的是
 * 天气系统——它要在同一帧里叠加云量、灰度与雷闪，两套系统各写一次会打架。
 */
export class DayNightSystem implements SceneVisualSystem, SkyStateSource, DayNightVisualTarget {
  public readonly root: THREE.Group;

  private readonly visuals = createCelestialVisuals();
  /** 当前时刻。由主线程每帧发过来，见 `setTimeOfDay`。 */
  private hour: number;
  /** 时钟走不走。星空旋转要看它——冻结的时刻不该让星星继续转。 */
  private clockRunning: boolean;
  private readonly background: THREE.Color;
  private readonly random = createRandom(0x1d3c_9f11);
  private readonly sunPosition = new THREE.Vector3();
  private readonly moonPosition = new THREE.Vector3();
  private readonly meteorStates: MeteorState[] = [];
  private readonly state: SkyState = {
    timeOfDay: 0,
    night: 0,
    dayFactor: 1,
    twilight: 0,
    moonlit: 0,
    skyColor: new THREE.Color(0xfdfbf6),
    ambientColor: new THREE.Color(0xffffff),
    ambientBrightness: 1,
    sunDirection: new THREE.Vector3(-0.55, 0.9, 0.35).normalize(),
    scatterColor: new THREE.Color(0xffe6b8),
    scatterStrength: 0,
    directLight: 1,
    sunElevation: 1,
    moonElevation: -1,
  };

  private weatherSource?: WeatherFieldSource;
  private starOpacity = 0;
  private meteorTimer = 6;
  private disposed = false;

  public constructor(definition: DayNightEnvironmentDefinition) {
    this.root = this.visuals.root;
    this.background = new THREE.Color(definition.backgroundColor);
    this.hour = definition.dayNight.startHour;
    this.clockRunning = definition.dayNight.enabled && !definition.dayNight.paused
      && definition.dayNight.dayLengthSeconds > 0;
    for (let index = 0; index < CELESTIAL_VISUAL_CAPACITY.meteors; index += 1) {
      this.meteorStates.push({
        active: false,
        elapsed: 0,
        life: 1,
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
      });
    }
    // 第一帧渲染之前就要有合法天空状态：天气系统同一帧就会读它。
    this.update(0, 0);
  }

  /**
   * 天气影响日月的遮挡与星空亮度。两套系统互相要对方的状态，所以昼夜系统
   * 先更新、读上一帧的天气场量，天气系统再用本帧的天空状态合成最终环境。
   */
  public setWeatherSource(source: WeatherFieldSource): void {
    this.weatherSource = source;
  }

  /**
   * 当前时刻由外面给（引擎迁移路线图 第 3 步）。
   *
   * 时钟原来住在这里，于是「现在几点」要**从渲染世界读回来**——调试菜单的时钟就是
   * 这么显示的。`DayNightClock` 是纯状态（不 import three），本来就不该在这一侧。
   *
   * 现在它归主线程：那边推进、那边校正，每帧把小时数发过来。一个时刻只有一份，
   * 不会因为两侧各推各的而漂开。
   */
  public setTimeOfDay(timeOfDay: number, running: boolean): void {
    this.hour = timeOfDay;
    this.clockRunning = running;
  }

  public getSkyState(): Readonly<SkyState> {
    return this.state;
  }

  public update(deltaSeconds: number, elapsedSeconds: number): void {
    if (this.disposed) return;
    // 星空旋转与流星仍按帧步推进；只有「现在几点」不再由这一侧推。
    const dt = Math.max(0, Math.min(deltaSeconds, 0.1));
    const hour = this.hour;
    const field = this.weatherSource?.getWeatherField();
    const cloudCover = clamp01(field?.cloudCover ?? 0);
    // 云、降水与雾一起决定天空被挡住多少：厚云还能透出星星，落雨落雪不会。
    const overcast = clamp01(
      cloudCover * 0.5
        + clamp01(((field?.rain ?? 0) + (field?.snow ?? 0)) / 200)
        + clamp01(field?.fog ?? 0),
    );
    const night = clamp01(nightFactor(hour));
    const twilight = clamp01(twilightFactor(hour));

    this.updateCelestialTransforms(hour);
    const sunFade = clamp01(this.state.sunElevation / HORIZON_FADE_HEIGHT);
    const moonFade = clamp01(this.state.moonElevation / HORIZON_FADE_HEIGHT);
    // 云越厚月光越弱；晴夜的月光能把地面照出冷色，阴雨夜几乎只剩轮廓。
    const moonlit = night * moonFade * (0.5 - cloudCover * 0.45);

    this.state.timeOfDay = hour;
    this.state.night = night;
    this.state.dayFactor = 1 - night;
    this.state.twilight = twilight;
    this.state.moonlit = clamp01(moonlit);
    sampleSkyColor(hour, this.background, this.state.skyColor);

    this.state.ambientColor.setHex(0xffffff)
      .lerp(NIGHT_AMBIENT_COLOR, night * 0.9)
      .lerp(MOON_AMBIENT_COLOR, this.state.moonlit)
      .lerp(WARM_AMBIENT_COLOR, twilight * 0.5)
      .lerp(EMBER_AMBIENT_COLOR, twilight * 0.22);
    // 夜里要真的暗下来，但月光仍然把地面提回到看得清路的程度。
    this.state.ambientBrightness = Math.max(
      0.16,
      1 - night * 0.62 + this.state.moonlit * 0.3,
    );

    this.updateScattering();
    this.updateSun(sunFade, cloudCover);
    this.updateMoon(moonFade, cloudCover, elapsedSeconds);
    this.updateStars(dt, elapsedSeconds, skyDarkness(this.state.skyColor), overcast);
    this.updateMeteors(dt);
  }

  public beforeRender(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    if (this.disposed) return;
    // 天体是无限远元素：整组跟着相机走，观察原点因此永远在天球中心。
    this.root.position.copy(camera.position);
    // 天球按相机远裁剪面缩放：谁改了 far 或换了相机，星空都不会被裁掉一角。
    const far = camera instanceof THREE.PerspectiveCamera ? camera.far : 0;
    const domeScale = far > 0
      ? far * DOME_FAR_PLANE_MARGIN / CELESTIAL_RADIUS.stars
      : 1;
    this.root.scale.setScalar(domeScale);
    this.visuals.starMaterial.uniforms.uDomeScale.value = domeScale;
    this.visuals.starMaterial.uniforms.uPixelRatio.value = renderer.getPixelRatio();
    if (this.visuals.sunRoot.visible) this.visuals.sunRoot.lookAt(camera.position);
    if (this.visuals.moonRoot.visible) this.visuals.moonRoot.lookAt(camera.position);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.visuals.dispose();
  }

  private updateCelestialTransforms(hour: number): void {
    const sun = sunAngle(hour);
    // 轨道压扁并往画面深处推，日月因此斜着划过天空，而不是贴着屏幕平面转。
    this.sunPosition.set(
      Math.cos(sun) * CELESTIAL_RADIUS.sun * 0.82,
      Math.sin(sun) * CELESTIAL_RADIUS.sun,
      -0.56 * CELESTIAL_RADIUS.sun,
    );
    const moon = moonAngle(hour);
    this.moonPosition.set(
      Math.cos(moon) * CELESTIAL_RADIUS.moon * 0.82,
      Math.sin(moon) * CELESTIAL_RADIUS.moon,
      -0.56 * CELESTIAL_RADIUS.moon,
    );
    this.visuals.sunRoot.position.copy(this.sunPosition);
    this.visuals.moonRoot.position.copy(this.moonPosition);
    this.state.sunElevation = this.sunPosition.y / CELESTIAL_RADIUS.sun;
    this.state.moonElevation = this.moonPosition.y / CELESTIAL_RADIUS.moon;

    // 太阳落山后把主光方向交给月亮，夜里的物体仍有明确的受光面。
    if (this.state.sunElevation > 0) {
      this.state.sunDirection.copy(this.sunPosition).normalize();
    } else if (this.state.moonElevation > 0) {
      this.state.sunDirection.copy(this.moonPosition).normalize();
    } else {
      this.state.sunDirection.set(0, 1, -0.25).normalize();
    }
  }

  /**
   * 方向性散射与直射光硬度。
   *
   * 太阳越贴近地平线，穿过的大气越厚：散射越强、颜色越红，影子也越长越软。
   * 这两个量分别喂给雾的朝阳染色和接触阴影，天气再按云量把它们压下去。
   */
  private updateScattering(): void {
    const elevation = this.state.sunElevation;
    const aboveHorizon = clamp01(elevation / 0.12);
    const grazing = 1 - clamp01(elevation / 0.45);
    this.state.scatterColor
      .copy(HIGH_SUN_SCATTER_COLOR)
      .lerp(LOW_SUN_SCATTER_COLOR, grazing * grazing);
    this.state.scatterStrength = aboveHorizon * (0.26 + 0.56 * grazing);
    this.state.directLight = aboveHorizon * (0.35 + 0.65 * clamp01(elevation / 0.55));
  }

  private updateSun(sunFade: number, cloudCover: number): void {
    const opacity = Math.max(0, 1 - cloudCover * 1.2) * sunFade;
    this.visuals.sunRoot.visible = opacity > 0.01;
    this.visuals.sunFillMaterial.opacity = opacity;
    this.visuals.sunLineMaterial.opacity = opacity;
    if (!this.visuals.sunRoot.visible) {
      this.visuals.sunGlowNearMaterial.uniforms.uOpacity.value = 0;
      this.visuals.sunGlowFarMaterial.uniforms.uOpacity.value = 0;
      return;
    }
    // 贴着地平线时暖光最强、铺得最开，正午收成一圈紧致的白金色。
    const elevation = this.state.sunElevation;
    const horizonFade = smoothstep01((elevation + 0.02) / 0.12);
    const bloom = Math.exp(-(((elevation - 0.06) / 0.16) ** 2));
    const visibility = Math.max(0, 1 - cloudCover * 0.85) * horizonFade;
    const horizonMix = Math.min(1, bloom * 1.3);
    this.visuals.sunGlowNearMaterial.uniforms.uColor.value.setRGB(
      1,
      0.8 + 0.1 * (1 - horizonMix),
      0.58 + 0.24 * (1 - horizonMix),
    );
    this.visuals.sunGlowNearMaterial.uniforms.uOpacity.value = (0.1 + 0.58 * bloom) * visibility;
    this.visuals.sunGlowFarMaterial.uniforms.uOpacity.value = (0.05 + 0.28 * bloom) * visibility;
    this.visuals.sunGlowNear.scale.setScalar(1 + 0.55 * bloom);
    this.visuals.sunGlowFar.scale.setScalar(1 + 0.35 * bloom);
  }

  private updateMoon(moonFade: number, cloudCover: number, elapsedSeconds: number): void {
    const opacity = Math.max(0, 1 - cloudCover * 1.2) * moonFade;
    this.visuals.moonRoot.visible = opacity > 0.01;
    this.visuals.moonFillMaterial.opacity = opacity;
    this.visuals.moonLineMaterial.opacity = opacity * 0.9;
    this.visuals.moonGlowMaterial.uniforms.uOpacity.value = this.visuals.moonRoot.visible
      ? (0.2 + 0.05 * Math.sin(elapsedSeconds * 0.6)) * opacity
      : 0;
  }

  private updateStars(
    deltaSeconds: number,
    elapsedSeconds: number,
    darkness: number,
    overcast: number,
  ): void {
    const target = clamp01((darkness - overcast) * 1.25);
    this.starOpacity = lerp(
      this.starOpacity,
      target,
      Math.min(1, deltaSeconds * STAR_FADE_SPEED),
    );
    this.visuals.starMaterial.uniforms.uOpacity.value = this.starOpacity;
    this.visuals.stars.visible = this.starOpacity > 0.004;
    if (!this.visuals.stars.visible) return;
    this.visuals.starMaterial.uniforms.uTime.value = elapsedSeconds;
    if (this.clockRunning) {
      this.visuals.stars.rotation.y += STAR_ROTATION_SPEED * deltaSeconds;
    }
  }

  private updateMeteors(deltaSeconds: number): void {
    const visibility = this.starOpacity;
    this.meteorTimer -= deltaSeconds;
    if (this.meteorTimer <= 0) {
      if (visibility > METEOR_STAR_THRESHOLD) this.spawnMeteor();
      this.meteorTimer = METEOR_MINIMUM_INTERVAL + this.random() * METEOR_INTERVAL_RANGE;
    }
    for (let index = 0; index < this.meteorStates.length; index += 1) {
      const meteor = this.meteorStates[index];
      const visual = this.visuals.meteors[index];
      if (!meteor.active) {
        if (visual.line.visible) {
          visual.line.visible = false;
          visual.material.opacity = 0;
        }
        continue;
      }
      meteor.elapsed += deltaSeconds;
      if (meteor.elapsed >= meteor.life) {
        meteor.active = false;
        visual.line.visible = false;
        visual.material.opacity = 0;
        continue;
      }
      const fade = Math.sin(Math.PI * meteor.elapsed / meteor.life);
      visual.material.opacity = fade * Math.min(1, visibility * 1.6);
      const speed = meteor.velocity.length();
      const trailLength = 9 + speed * 0.14;
      const points = CELESTIAL_VISUAL_CAPACITY.meteorTrailPoints;
      for (let point = 0; point < points; point += 1) {
        const along = point / (points - 1);
        const offset = trailLength * along / speed;
        visual.positions[point * 3] = meteor.position.x
          + meteor.velocity.x * (meteor.elapsed - offset);
        visual.positions[point * 3 + 1] = meteor.position.y
          + meteor.velocity.y * (meteor.elapsed - offset);
        visual.positions[point * 3 + 2] = meteor.position.z
          + meteor.velocity.z * (meteor.elapsed - offset);
        const brightness = (1 - along) ** 2.1;
        visual.colors[point * 3] = brightness;
        visual.colors[point * 3 + 1] = brightness * 0.97;
        visual.colors[point * 3 + 2] = brightness * 0.9;
      }
      visual.geometry.getAttribute('position').needsUpdate = true;
      visual.geometry.getAttribute('color').needsUpdate = true;
      visual.line.visible = true;
    }
  }

  private spawnMeteor(): void {
    const index = this.meteorStates.findIndex((meteor) => !meteor.active);
    if (index < 0) return;
    const meteor = this.meteorStates[index];
    const azimuth = this.random() * Math.PI * 2;
    const polar = Math.acos(0.25 + this.random() * 0.65);
    const radius = CELESTIAL_RADIUS.meteorSpawn;
    meteor.position.set(
      radius * Math.sin(polar) * Math.cos(azimuth),
      radius * Math.cos(polar) + 10,
      radius * Math.sin(polar) * Math.sin(azimuth),
    );
    const heading = this.random() * Math.PI * 2;
    const speed = 55 + this.random() * 30;
    meteor.velocity.set(
      Math.cos(heading) * speed * 0.85,
      -(18 + this.random() * 26),
      Math.sin(heading) * speed * 0.85,
    );
    meteor.life = 0.75 + this.random() * 0.5;
    meteor.elapsed = 0;
    meteor.active = true;
  }
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 0x1_0000_0000;
  };
}
