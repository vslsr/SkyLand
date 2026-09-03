import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  createFillMaterial,
  createSceneEnvironment,
} from '../src/materials/createFillMaterial';
import {
  GROUND_GRID_MATERIAL,
  OUTLINE_MATERIAL,
  resetEnvironmentInk,
} from '../src/materials/lineMaterials';
import {
  createChunkFillMaterial,
  createChunkGroundFillMaterial,
} from '../src/models/chunkMesh';
import { createGroundModel } from '../src/models/ground';
import {
  GRASS_FILL_FRAGMENT_SHADER,
  GRASS_OUTLINE_FRAGMENT_SHADER,
} from '../src/shaders/grass';
import { WEATHER_PARTICLE_LIMITS, WeatherSystem } from '../src/weather/index';

function createSystem(sampleGroundHeight: (x: number, z: number) => number = () => 2): {
  scene: THREE.Scene;
  system: WeatherSystem;
  environment: ReturnType<typeof createSceneEnvironment>;
} {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#fdfbf6');
  scene.fog = new THREE.Fog('#fdfbf6', 22, 52);
  const environment = createSceneEnvironment('#fdfbf6', 22, 52);
  const system = new WeatherSystem(scene, {
    backgroundColor: '#fdfbf6',
    fogColor: '#fdfbf6',
    fogNear: 22,
    fogFar: 52,
    runtime: environment.runtime,
    sampleGroundHeight,
  });
  scene.add(system.root);
  return { scene, system, environment };
}

function settle(
  system: WeatherSystem,
  seconds: number,
  focusX = 0,
  focusZ = 0,
): void {
  const step = 0.1;
  for (let elapsed = 0; elapsed < seconds; elapsed += step) {
    system.update(step, elapsed, { focusX, focusY: 7, focusZ });
  }
}

function rainPositionArray(system: WeatherSystem): Float32Array {
  const rain = system.root.getObjectByName('chunk-weather-rain') as THREE.LineSegments;
  return rain.geometry.getAttribute('position').array as Float32Array;
}

function snowPositionArray(system: WeatherSystem): Float32Array {
  const snow = system.root.getObjectByName('chunk-weather-snow') as THREE.LineSegments;
  return snow.geometry.getAttribute('position').array as Float32Array;
}

test('雨雪保留 Chunk 激活，并以绝对世界坐标维护玩家附近滑动窗口', () => {
  const { system } = createSystem();
  system.setWeather('storm');
  settle(system, 14, 5, 7);

  assert.deepEqual(system.root.position.toArray(), [0, 0, 0]);
  assert.equal(system.getActiveChunkKeys().length, 9);
  assert.deepEqual(
    new Set(system.getActiveChunkKeys()),
    new Set([
      '0:0', '-1:0', '0:-1', '0:1', '1:0',
      '-1:-1', '-1:1', '1:-1', '1:1',
    ]),
  );
  assert.ok(system.getParticleCounts().rain > 400);
  assert.ok(system.getParticleCounts().rain <= WEATHER_PARTICLE_LIMITS.rainDrops);
  const rain = system.root.getObjectByName('chunk-weather-rain') as THREE.LineSegments<
    THREE.BufferGeometry,
    THREE.LineBasicMaterial
  >;
  assert.equal(rain.material.color.getHexString(), '527fa6');
  assert.equal(rain.material.fog, false);
  assert.equal(rain.material.toneMapped, false);
  assert.ok(rain.material.opacity >= 0.79);

  const beforeKeys = system.getActiveChunkKeys();
  const beforePositions = rainPositionArray(system).slice();
  system.update(0, 15, { focusX: 6, focusY: 3, focusZ: 7 });
  assert.deepEqual(system.getActiveChunkKeys(), beforeKeys);
  const afterSmallMove = rainPositionArray(system);
  let unchangedDrops = 0;
  for (let index = 0; index < system.getParticleCounts().rain; index += 1) {
    const offset = index * 6;
    if (
      afterSmallMove[offset] === beforePositions[offset]
      && afterSmallMove[offset + 1] === beforePositions[offset + 1]
      && afterSmallMove[offset + 2] === beforePositions[offset + 2]
    ) unchangedDrops += 1;
  }
  assert.ok(
    unchangedDrops > system.getParticleCounts().rain * 0.85,
    '玩家小范围移动时绝大多数雨点应留在原世界坐标，而不是整片跟随平移',
  );
  assert.deepEqual(system.root.position.toArray(), [0, 0, 0]);

  system.update(0, 15, { focusX: 31.99, focusY: 3, focusZ: 7 });
  const recenteredRain = rainPositionArray(system);
  for (let index = 0; index < system.getParticleCounts().rain; index += 1) {
    const offset = index * 6;
    assert.ok(Math.abs(recenteredRain[offset] - 31.99) <= 17);
    assert.ok(Math.abs(recenteredRain[offset + 2] - 7) <= 17);
  }

  system.update(0, 15, { focusX: 32, focusY: 3, focusZ: 7 });
  const afterKeys = new Set(system.getActiveChunkKeys());
  assert.equal(afterKeys.size, 9);
  assert.ok(afterKeys.has('2:0'));
  assert.ok(!afterKeys.has('-1:0'));
  assert.deepEqual(system.root.position.toArray(), [0, 0, 0]);

  system.dispose();
});

test('负坐标和快速传送直接替换天气 chunk，容量保持有界', () => {
  const { scene, system } = createSystem();
  system.setWeather('blizzard');
  settle(system, 14, -0.01, -0.01);
  const negativeKeys = new Set(system.getActiveChunkKeys());
  assert.ok(negativeKeys.has('-2:-2'));
  assert.ok(negativeKeys.has('0:0'));

  system.update(0, 15, { focusX: 160.5, focusY: 100, focusZ: -160.5 });
  assert.equal(system.getActiveChunkKeys().length, 9);
  assert.ok(system.getActiveChunkKeys().includes('5:-6'));
  assert.deepEqual(system.root.position.toArray(), [0, 0, 0]);
  assert.ok(system.getParticleCounts().snow > 300);
  assert.ok(system.getParticleCounts().snow <= WEATHER_PARTICLE_LIMITS.snowFlakes);
  const snow = system.root.getObjectByName('chunk-weather-snow') as THREE.LineSegments<
    THREE.BufferGeometry,
    THREE.LineBasicMaterial
  >;
  assert.equal(snow.material.color.getHexString(), '91b9df');
  assert.equal(snow.material.fog, false);
  assert.equal(snow.material.toneMapped, false);
  const snowPositions = snowPositionArray(system);
  for (let index = 0; index < system.getParticleCounts().snow; index += 1) {
    const offset = index * 18;
    const centerX = (snowPositions[offset] + snowPositions[offset + 3]) * 0.5;
    const centerZ = snowPositions[offset + 2];
    assert.ok(Math.abs(centerX - 160.5) <= 17);
    assert.ok(Math.abs(centerZ + 160.5) <= 17);
  }
  assert.ok((scene.fog as THREE.Fog).far < 52);

  system.dispose();
  assert.equal(system.root.children.length, 0);
});

test('雨滴接近地面时才复采高度，并用固定共享缓冲绘制落地水花', () => {
  let groundHeight = 0;
  let sampleCount = 0;
  const { system } = createSystem(() => {
    sampleCount += 1;
    return groundHeight;
  });
  const samplesAfterCreation = sampleCount;
  groundHeight = 3;
  system.setWeather('storm');
  settle(system, 2);

  const counts = system.getParticleCounts();
  assert.ok(counts.rain > 300);
  assert.ok(counts.rainSplashes > 0);
  assert.ok(counts.rainSplashes <= WEATHER_PARTICLE_LIMITS.rainSplashes);
  // 如果逐帧查询，2 秒内至少会有 rain × 20 次；两阶段方案远低于该数量。
  assert.ok(sampleCount - samplesAfterCreation < WEATHER_PARTICLE_LIMITS.rainDrops * 4);

  const splashes = system.root.getObjectByName(
    'chunk-weather-rain-splashes',
  ) as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  assert.equal(splashes.material.color.getHexString(), '6fa4cf');
  assert.equal(splashes.material.fog, false);
  assert.equal(splashes.material.toneMapped, false);
  assert.equal(
    splashes.geometry.drawRange.count,
    counts.rainSplashes * 12 * 2,
  );
  const positions = splashes.geometry.getAttribute('position').array as Float32Array;
  for (let index = 1; index < splashes.geometry.drawRange.count * 3; index += 3) {
    assert.ok(positions[index] >= groundHeight, '水花顶点不能落到采样地面以下');
    assert.ok(positions[index] < groundHeight + 0.25, '水花必须紧贴采样地面');
  }

  system.dispose();
});

test('晴天与多云共享同一套场景雾和光照 uniform', () => {
  const { system, environment } = createSystem();
  const material = createFillMaterial('#c1d7a6', environment);

  settle(system, 6);
  const sunny = system.getLightingState();
  const sunnyAmbient = environment.runtime!.ambientColor.value.clone();
  // 没有昼夜系统时天空恒为场景背景色，光照与接入昼夜之前一致。
  assert.equal(sunny.skyColor, '#fdfbf6');
  assert.equal(sunny.daylight > 0.85, true);
  assert.equal(material.uniforms.uAmbientColor, environment.runtime!.ambientColor);
  assert.equal(material.uniforms.uDaylight, environment.runtime!.daylight);
  assert.equal(material.uniforms.uFogColor, environment.runtime!.fogColor);

  system.setWeather('cloudy');
  settle(system, 14);
  const cloudy = system.getLightingState();
  assert.ok(cloudy.daylight < sunny.daylight * 0.55);
  assert.ok(cloudy.cloudCover > sunny.cloudCover * 3);
  assert.ok(environment.runtime!.ambientColor.value.getHex() !== sunnyAmbient.getHex());
  assert.ok(environment.runtime!.fogFar.value < 52);

  material.dispose();
  system.dispose();
});

test('普通物体保持清晰，仅流式物件在远端边缘混入天气距离雾', () => {
  const environment = createSceneEnvironment('#fdfbf6', 22, 52);
  const ordinaryMaterial = createFillMaterial('#c1d7a6', environment);
  const propMaterial = createChunkFillMaterial(environment);
  const terrainMaterial = createChunkGroundFillMaterial(environment);
  assert.ok(!('USE_DISTANCE_FOG' in ordinaryMaterial.defines));
  assert.ok('USE_DISTANCE_FOG' in propMaterial.defines);
  assert.ok(propMaterial.fragmentShader.includes('uFogFar - 12.0'));
  assert.ok(!('USE_DISTANCE_FOG' in terrainMaterial.defines));
  assert.ok('USE_VERTEX_TINT' in terrainMaterial.defines);
  assert.equal(GROUND_GRID_MATERIAL.fog, false);

  const fixedGround = createGroundModel('#f1eddf', environment);
  const fixedGroundMesh = fixedGround.getObjectByProperty('type', 'Mesh') as THREE.Mesh;
  const fixedGroundMaterial = fixedGroundMesh.material as THREE.ShaderMaterial;
  assert.ok(!('USE_DISTANCE_FOG' in fixedGroundMaterial.defines));
  assert.ok(!GRASS_FILL_FRAGMENT_SHADER.includes('uFogColor'));
  assert.ok(!GRASS_OUTLINE_FRAGMENT_SHADER.includes('uFogColor'));

  ordinaryMaterial.dispose();
  propMaterial.dispose();
  terrainMaterial.dispose();
  fixedGround.traverse((object) => {
    const renderable = object as THREE.Mesh & { material?: THREE.Material };
    renderable.geometry?.dispose();
    renderable.material?.dispose();
  });
});


function skyLuminance(color: THREE.Color): number {
  return color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722;
}

test('纸面被夜色压暗时墨线浮上来，网格让位给物件轮廓', () => {
  const state = {
    timeOfDay: 12,
    night: 0,
    dayFactor: 1,
    twilight: 0,
    moonlit: 0,
    skyColor: new THREE.Color('#fdfbf6'),
    ambientColor: new THREE.Color(0xffffff),
    ambientBrightness: 1,
    sunDirection: new THREE.Vector3(-0.55, 0.9, 0.35).normalize(),
    scatterColor: new THREE.Color(0xffe6b8),
    scatterStrength: 0,
    directLight: 1,
    sunElevation: 1,
    moonElevation: -1,
  };
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#fdfbf6');
  scene.fog = new THREE.Fog('#fdfbf6', 22, 52);
  const environment = createSceneEnvironment('#fdfbf6', 22, 52);
  const system = new WeatherSystem(scene, {
    backgroundColor: '#fdfbf6',
    fogColor: '#fdfbf6',
    fogNear: 22,
    fogFar: 52,
    runtime: environment.runtime,
    sampleGroundHeight: () => 2,
    sky: { getSkyState: () => state },
  });

  settle(system, 4);
  const noonInk = skyLuminance(OUTLINE_MATERIAL.color);
  const noonGrid = skyLuminance(GROUND_GRID_MATERIAL.color);
  const noonGridOpacity = GROUND_GRID_MATERIAL.opacity;
  // 正午的中性白光下，墨色与网格与基准完全一致。
  assert.ok(noonInk < 0.12);

  state.timeOfDay = 0;
  state.night = 1;
  state.dayFactor = 0;
  state.ambientColor.setRGB(0.25, 0.28, 0.38);
  state.ambientBrightness = 0.2;
  state.directLight = 0;
  settle(system, 4);

  // 纸面沉下去时墨要浮上来，否则轮廓线会整个陷进暗地里。
  assert.ok(skyLuminance(OUTLINE_MATERIAL.color) > noonInk * 4);
  // 网格反过来跟着纸面变暗、变淡：画面里最醒目的应当是物件而不是刻度。
  assert.ok(skyLuminance(GROUND_GRID_MATERIAL.color) < noonGrid * 0.6);
  assert.ok(GROUND_GRID_MATERIAL.opacity < noonGridOpacity);
  assert.ok(skyLuminance(OUTLINE_MATERIAL.color) > skyLuminance(GROUND_GRID_MATERIAL.color));

  system.dispose();
  resetEnvironmentInk();
  assert.equal(GROUND_GRID_MATERIAL.opacity, noonGridOpacity);
});
