import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { DAY_PHASE_HOURS } from '../shared/dayNight.mjs';
import { DayNightSystem } from '../src/environment/index';
import { CELESTIAL_RADIUS } from '../src/models/sky/createCelestialVisuals';
import { CONTACT_SHADOW_UNIFORMS } from '../src/materials/createContactShadowMaterial';
import { createSceneEnvironment } from '../src/materials/createFillMaterial';
import { OUTLINE_MATERIAL } from '../src/materials/lineMaterials';
import type { SceneDayNightDefinition } from '../src/scenes/data/SceneDefinition';
import { WeatherSystem } from '../src/weather/index';

const BACKGROUND = '#c9e6f2';

function createDayNight(
  overrides: Partial<SceneDayNightDefinition> = {},
): DayNightSystem {
  return new DayNightSystem({
    backgroundColor: BACKGROUND,
    dayNight: {
      enabled: true,
      paused: false,
      startHour: DAY_PHASE_HOURS.noon,
      dayLengthSeconds: 240,
      allowPlayerControl: true,
      ...overrides,
    },
  });
}

function settle(system: { update(delta: number, elapsed: number): void }, seconds: number): void {
  const step = 0.1;
  for (let elapsed = 0; elapsed < seconds; elapsed += step) system.update(step, elapsed);
}

test('本地时钟按服务端速率推进，小偏差追赶、大偏差直接跳过去', () => {
  const system = createDayNight({ startHour: 6 });
  // 一天 240 秒即每秒 0.1 小时；推进 6 秒应该正好走到 6.6 点。
  settle(system, 6);
  assert.ok(Math.abs(system.timeOfDay - 6.6) < 0.02, `实际 ${system.timeOfDay}`);

  system.applyServerTime(6.7, 240);
  assert.ok(system.timeOfDay > 6.6 && system.timeOfDay < 6.7);

  system.applyServerTime(21.5, 240);
  assert.equal(system.timeOfDay, 21.5);

  // 冻结的房间不再本地推进，时刻完全由快照决定。
  system.applyServerTime(21.5, 0);
  settle(system, 5);
  assert.equal(system.timeOfDay, 21.5);
  system.dispose();
});

test('关闭昼夜的场景恒定停在配置时刻，天空就是场景背景色', () => {
  const system = createDayNight({ enabled: false });
  settle(system, 30);
  const sky = system.getSkyState();
  assert.equal(system.timeOfDay, DAY_PHASE_HOURS.noon);
  assert.equal(`#${sky.skyColor.getHexString()}`, BACKGROUND);
  assert.equal(sky.night, 0);
  assert.equal(sky.dayFactor, 1);
  assert.equal(sky.ambientColor.getHex(), 0xffffff);
  system.dispose();
});

test('正午出日轮、深夜出月亮与星空，日月始终跟随相机原点', () => {
  const system = createDayNight({ startHour: DAY_PHASE_HOURS.noon, dayLengthSeconds: 0 });
  const sun = system.root.getObjectByName('daynight-sun') as THREE.Group;
  const moon = system.root.getObjectByName('daynight-moon') as THREE.Group;
  const stars = system.root.getObjectByName('daynight-stars') as THREE.Points;

  system.applyServerTime(DAY_PHASE_HOURS.noon, 0);
  settle(system, 3);
  assert.equal(sun.visible, true);
  assert.ok(system.getSkyState().sunElevation > 0.9);
  assert.equal(moon.visible, false);
  assert.equal(stars.visible, false);

  system.applyServerTime(23, 0);
  settle(system, 4);
  const night = system.getSkyState();
  assert.equal(night.night, 1);
  assert.equal(night.dayFactor, 0);
  assert.equal(sun.visible, false);
  assert.equal(moon.visible, true);
  assert.equal(stars.visible, true);
  assert.ok(night.moonlit > 0.4);
  // 夜里主光交给月亮，物体仍有明确的受光面。
  assert.ok(night.sunDirection.y > 0);
  // 深夜天空必须明显暗于纸面背景色。
  assert.ok(night.skyColor.r < 0.15 && night.skyColor.g < 0.15);

  // 高 DPI 屏上星点尺寸要跟着 pixelRatio 走，否则只有设计尺寸的一半。
  const renderer = { getPixelRatio: () => 2 } as unknown as THREE.WebGLRenderer;
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(120, 6, -80);
  system.beforeRender(renderer, camera);
  assert.deepEqual(system.root.position.toArray(), [120, 6, -80]);
  const starMaterial = stars.material as THREE.ShaderMaterial;
  assert.equal(starMaterial.uniforms.uPixelRatio.value, 2);

  // 天球贴着远裁剪面缩放：整片星空必须留在相机看得见的范围里。
  moon.updateWorldMatrix(true, false);
  const moonWorld = new THREE.Vector3().setFromMatrixPosition(moon.matrixWorld);
  assert.ok(moonWorld.distanceTo(camera.position) > 40);
  const farthestStar = CELESTIAL_RADIUS.stars * system.root.scale.x;
  assert.ok(farthestStar < camera.far, `星空半径 ${farthestStar} 越过了远裁剪面`);

  // 换一个远裁剪面更小的相机，天球跟着收进去而不是被裁掉。
  const nearCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 40);
  nearCamera.position.copy(camera.position);
  system.beforeRender(renderer, nearCamera);
  assert.ok(CELESTIAL_RADIUS.stars * system.root.scale.x < nearCamera.far);

  system.dispose();
  assert.equal(system.root.children.length, 0);
});

test('天气叠在昼夜天空之上：暴雨压灰天色、云层遮住日轮与星空', () => {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND);
  scene.fog = new THREE.Fog(BACKGROUND, 22, 52);
  const environment = createSceneEnvironment(BACKGROUND, 22, 52);
  const dayNight = createDayNight({ startHour: DAY_PHASE_HOURS.noon, dayLengthSeconds: 0 });
  const weather = new WeatherSystem(scene, {
    backgroundColor: BACKGROUND,
    fogColor: BACKGROUND,
    fogNear: 22,
    fogFar: 52,
    runtime: environment.runtime,
    sky: dayNight,
    sampleGroundHeight: () => 0,
  });
  dayNight.setWeatherSource(weather);

  const step = (seconds: number): void => {
    const dt = 0.1;
    for (let elapsed = 0; elapsed < seconds; elapsed += dt) {
      dayNight.update(dt, elapsed);
      weather.update(dt, elapsed, { focusX: 0, focusZ: 0 });
    }
  };

  step(4);
  const noon = weather.getLightingState();
  // 晴朗正午：天空与雾都还原成场景自己的纸面色。
  assert.equal(noon.skyColor, BACKGROUND);
  assert.equal(`#${environment.runtime!.fogColor.value.getHexString()}`, BACKGROUND);
  assert.ok(noon.daylight > 0.85);

  weather.setWeather('storm');
  step(16);
  const storm = weather.getLightingState();
  assert.ok(storm.daylight < noon.daylight * 0.5);
  assert.notEqual(storm.skyColor, noon.skyColor);
  assert.ok(weather.getWeatherField().cloudCover > 0.9);
  // 云量拉满时日轮被完全遮住。
  const sun = dayNight.root.getObjectByName('daynight-sun') as THREE.Group;
  assert.equal(sun.visible, false);

  // 同一场暴雨在深夜比正午更暗。
  const stormNoonDaylight = storm.daylight;
  dayNight.applyServerTime(23, 0);
  step(4);
  assert.ok(weather.getLightingState().daylight < stormNoonDaylight);
  // 厚云的夜里星空仍然不该露出来。
  const stars = dayNight.root.getObjectByName('daynight-stars') as THREE.Points;
  assert.equal(stars.visible, false);

  weather.dispose();
  dayNight.dispose();
});

test('太阳角度与云量驱动散射雾、半球染色、云影、墨色与接触阴影', () => {
  // 用中性纸面色建场景：正午不该引入任何额外色偏，蓝色背景会掩盖这一点。
  const paper = '#fdfbf6';
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(paper);
  scene.fog = new THREE.Fog(paper, 22, 52);
  const environment = createSceneEnvironment(paper, 22, 52);
  const runtime = environment.runtime!;
  const dayNight = new DayNightSystem({
    backgroundColor: paper,
    groundColor: '#f1eddf',
    dayNight: {
      enabled: true,
      paused: true,
      startHour: DAY_PHASE_HOURS.noon,
      dayLengthSeconds: 0,
      allowPlayerControl: true,
    },
  });
  const weather = new WeatherSystem(scene, {
    backgroundColor: paper,
    fogColor: paper,
    fogNear: 22,
    fogFar: 52,
    runtime,
    sky: dayNight,
    groundColor: '#f1eddf',
    sampleGroundHeight: () => 0,
  });
  dayNight.setWeatherSource(weather);

  const step = (seconds: number): void => {
    const dt = 0.1;
    for (let elapsed = 0; elapsed < seconds; elapsed += dt) {
      dayNight.update(dt, elapsed);
      weather.update(dt, elapsed, { focusX: 0, focusZ: 0 });
    }
  };

  step(4);
  const noonScatter = runtime.scatterStrength.value;
  // 晴朗正午：半球染色与墨色都是中性的，画面和没有这些项时一致。
  assert.ok(Math.abs(runtime.skyTint.value.r - runtime.skyTint.value.b) < 0.03);
  assert.ok(Math.abs(runtime.inkTint.value.r - runtime.inkTint.value.b) < 0.03);
  assert.ok(noonScatter > 0.2, `正午也应有一点散射，实际 ${noonScatter}`);
  // 高日角 + 干净天空 = 硬光，接触阴影最清楚。
  const clearNoonShadow = CONTACT_SHADOW_UNIFORMS.uShadowStrength.value;
  assert.ok(clearNoonShadow > 0.6);
  assert.ok(runtime.cloudShadowStrength.value < 0.05);

  // 日落前的低日角：散射最强、颜色最暖。
  dayNight.applyServerTime(17.4, 0);
  step(3);
  assert.ok(runtime.scatterStrength.value > noonScatter);
  assert.ok(runtime.scatterColor.value.r > runtime.scatterColor.value.b * 1.4);
  // 天顶染色跟着暖天色走，朝上的面因此偏暖。
  assert.ok(runtime.skyTint.value.r > runtime.skyTint.value.b);

  // 日轮沉到地平线以下之后只剩余晖，没有朝阳方向的散射可言。
  dayNight.applyServerTime(19, 0);
  step(3);
  assert.equal(runtime.scatterStrength.value, 0);

  // 阴天：出现云影，直射光变软，接触阴影跟着化开。
  dayNight.applyServerTime(DAY_PHASE_HOURS.noon, 0);
  weather.setWeather('cloudy');
  step(16);
  assert.ok(runtime.cloudShadowStrength.value > 0.1);
  assert.ok(CONTACT_SHADOW_UNIFORMS.uShadowStrength.value < clearNoonShadow * 0.5);
  // 云影随风漂移，不会停在同一片地上。
  const beforeOffset = runtime.cloudShadowOffset.value.clone();
  step(3);
  assert.ok(runtime.cloudShadowOffset.value.distanceTo(beforeOffset) > 0);

  // 深夜：墨线偏冷，接触阴影几乎消失。
  weather.setWeather('sunny');
  dayNight.applyServerTime(23, 0);
  step(16);
  assert.ok(runtime.inkTint.value.b > runtime.inkTint.value.r * 1.05);
  assert.ok(OUTLINE_MATERIAL.color.b > OUTLINE_MATERIAL.color.r);
  assert.equal(CONTACT_SHADOW_UNIFORMS.uShadowStrength.value, 0);

  // 卸载后共享墨线恢复基准色，下一张地图不会继承上一张的天色。
  weather.dispose();
  assert.equal(`#${OUTLINE_MATERIAL.color.getHexString()}`, '#171614');
  dayNight.dispose();
});
