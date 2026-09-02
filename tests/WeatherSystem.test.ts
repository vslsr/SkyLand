import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  createFillMaterial,
  createSceneEnvironment,
} from '../src/materials/createFillMaterial';
import { GROUND_GRID_MATERIAL } from '../src/materials/lineMaterials';
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

function createSystem(): {
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
    sampleGroundHeight: () => 2,
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

test('雨雪按世界 chunk 激活，同一 chunk 内不会跟玩家平移', () => {
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

  const beforeKeys = system.getActiveChunkKeys();
  const beforePositions = rainPositionArray(system).slice();
  system.update(0, 15, { focusX: 31.99, focusY: 3, focusZ: 7 });
  assert.deepEqual(system.getActiveChunkKeys(), beforeKeys);
  assert.deepEqual(rainPositionArray(system), beforePositions);
  assert.deepEqual(system.root.position.toArray(), [0, 0, 0]);

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
  assert.ok((scene.fog as THREE.Fog).far < 52);

  system.dispose();
  assert.equal(system.root.children.length, 0);
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

test('固定地面、流式台地、网格与地面草叶不混入天气距离雾', () => {
  const environment = createSceneEnvironment('#fdfbf6', 22, 52);
  const propMaterial = createChunkFillMaterial(environment);
  const terrainMaterial = createChunkGroundFillMaterial(environment);
  assert.ok('USE_DISTANCE_FOG' in propMaterial.defines);
  assert.ok(!('USE_DISTANCE_FOG' in terrainMaterial.defines));
  assert.ok('USE_VERTEX_TINT' in terrainMaterial.defines);
  assert.equal(GROUND_GRID_MATERIAL.fog, false);

  const fixedGround = createGroundModel('#f1eddf', environment);
  const fixedGroundMesh = fixedGround.getObjectByProperty('type', 'Mesh') as THREE.Mesh;
  const fixedGroundMaterial = fixedGroundMesh.material as THREE.ShaderMaterial;
  assert.ok(!('USE_DISTANCE_FOG' in fixedGroundMaterial.defines));
  assert.ok(!GRASS_FILL_FRAGMENT_SHADER.includes('uFogColor'));
  assert.ok(!GRASS_OUTLINE_FRAGMENT_SHADER.includes('uFogColor'));

  propMaterial.dispose();
  terrainMaterial.dispose();
  fixedGround.traverse((object) => {
    const renderable = object as THREE.Mesh & { material?: THREE.Material };
    renderable.geometry?.dispose();
    renderable.material?.dispose();
  });
});
