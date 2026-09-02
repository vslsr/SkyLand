import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { DAY_PHASE_HOURS } from '../shared/dayNight.mjs';
import { DayNightSystem } from '../src/environment/index';
import { createSceneEnvironment } from '../src/materials/createFillMaterial';
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

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(120, 6, -80);
  system.beforeRender(undefined as unknown as THREE.WebGLRenderer, camera);
  assert.deepEqual(system.root.position.toArray(), [120, 6, -80]);
  moon.updateWorldMatrix(true, false);
  const moonWorld = new THREE.Vector3().setFromMatrixPosition(moon.matrixWorld);
  assert.ok(moonWorld.distanceTo(camera.position) > 40);

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
