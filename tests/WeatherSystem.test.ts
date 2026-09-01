import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  createFillMaterial,
  createSceneEnvironment,
} from '../src/materials/createFillMaterial';
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
  assert.equal(material.uniforms.uAmbientColor, environment.runtime!.ambientColor);
  assert.equal(material.uniforms.uDaylight, environment.runtime!.daylight);
  assert.equal(material.uniforms.uFogColor, environment.runtime!.fogColor);

  system.setWeather('cloudy');
  settle(system, 14);
  const cloudy = system.getLightingState();
  assert.ok(cloudy.daylight < sunny.daylight * 0.55);
  assert.ok(cloudy.sunOpacity < sunny.sunOpacity * 0.2);
  assert.ok(environment.runtime!.ambientColor.value.getHex() !== sunnyAmbient.getHex());
  assert.ok(environment.runtime!.fogFar.value < 52);

  material.dispose();
  system.dispose();
});
