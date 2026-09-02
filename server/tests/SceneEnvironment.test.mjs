import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SceneCatalog } from '../scenes/SceneCatalog.mjs';
import { SceneEnvironmentDirector } from '../scene/SceneEnvironmentDirector.mjs';
import { DEFAULT_START_HOUR } from '../../shared/dayNight.mjs';

/**
 * 天气与昼夜是房间权威状态，客户端只渲染结果。
 *
 * 这里覆盖两件事：场景 JSON 的 `environment` 在服务器启动时被严格校验；
 * 推进器按配置切换天气、推进时钟，并且能整块关掉客户端的切换请求。
 */
function createSceneFile(environment) {
  return {
    $schema: './scene.schema.json',
    schemaVersion: 1,
    id: 'environment-probe',
    displayName: '环境探针',
    description: '用于校验天气与昼夜配置的测试地图。',
    capacity: 4,
    sceneComponents: [],
    ...(environment === undefined ? {} : { environment }),
    actors: [],
    renderer: {
      type: 'line-art',
      background: '#fdfbf6',
      fog: { color: '#fdfbf6', near: 22, far: 52 },
      content: { ground: true, trees: false, grass: false, ocean: false },
      palette: {
        ground: '#f1eddf',
        grass: '#c1d7a6',
        treeTrunk: '#d6bea3',
        treeNeedles: '#cbdcbc',
      },
    },
    gameplay: {
      playerActor: { archetype: 'player-slime' },
      bounds: { minimumX: -16, maximumX: 16, minimumZ: -16, maximumZ: 16 },
      spawn: { centerX: 0, centerZ: 0, radius: 2, slots: 4 },
    },
    camera: { mode: 'topdown', position: [5.5, 7.5, 8.5], yaw: 0, pitch: -0.12, moveSpeed: 6.5 },
  };
}

async function loadSingleScene(scene) {
  const directory = await mkdtemp(join(tmpdir(), 'skyland-environment-'));
  await writeFile(join(directory, 'probe.scene.json'), JSON.stringify(scene), 'utf8');
  return SceneCatalog.load(directory);
}

test('缺省的 environment 得到晴天与停在正午的冻结时钟', async () => {
  const catalog = await loadSingleScene(createSceneFile());
  const environment = catalog.require('environment-probe').environment;

  assert.deepEqual(environment.weather, { initial: 'sunny', allowPlayerControl: true });
  assert.deepEqual(environment.dayNight, {
    enabled: false,
    paused: false,
    startHour: DEFAULT_START_HOUR,
    dayLengthSeconds: 900,
    allowPlayerControl: true,
  });
});

test('天气轮换与昼夜参数按场景配置净化', async () => {
  const catalog = await loadSingleScene(createSceneFile({
    weather: {
      initial: 'fog',
      allowPlayerControl: false,
      cycle: {
        minimumSeconds: 30,
        maximumSeconds: 60,
        candidates: ['fog', 'rain', 'storm'],
      },
    },
    dayNight: { enabled: true, startHour: 18.5, dayLengthSeconds: 300 },
  }));
  const environment = catalog.require('environment-probe').environment;

  assert.equal(environment.weather.initial, 'fog');
  assert.equal(environment.weather.allowPlayerControl, false);
  assert.deepEqual(environment.weather.cycle, {
    enabled: true,
    minimumSeconds: 30,
    maximumSeconds: 60,
    candidates: ['fog', 'rain', 'storm'],
  });
  assert.equal(environment.dayNight.enabled, true);
  assert.equal(environment.dayNight.startHour, 18.5);
  assert.equal(environment.dayNight.dayLengthSeconds, 300);
});

test('非法的天气与昼夜配置阻止服务器启动', async () => {
  await assert.rejects(
    loadSingleScene(createSceneFile({ weather: { initial: 'sandstorm' } })),
    /environment.weather.initial/,
  );
  await assert.rejects(
    loadSingleScene(createSceneFile({
      weather: { cycle: { minimumSeconds: 90, maximumSeconds: 30, candidates: ['rain', 'snow'] } },
    })),
    /maximumSeconds 不小于 minimumSeconds/,
  );
  await assert.rejects(
    loadSingleScene(createSceneFile({
      weather: { cycle: { minimumSeconds: 30, maximumSeconds: 60, candidates: ['rain'] } },
    })),
    /启用轮换时至少需要 2 种天气/,
  );
  await assert.rejects(
    loadSingleScene(createSceneFile({ dayNight: { enabled: true, startHour: 24 } })),
    /startHour 必须落在/,
  );
  await assert.rejects(
    loadSingleScene(createSceneFile({ dayNight: { enabled: true, dayLengthSeconds: 5 } })),
    /dayLengthSeconds 必须落在/,
  );
  await assert.rejects(
    loadSingleScene(createSceneFile({ dayNight: { enabled: true, sunColor: '#ffffff' } })),
    /environment.dayNight.sunColor 不受支持/,
  );
});

test('昼夜时钟按配置推进，冻结时只播报时刻不播报速率', () => {
  const director = new SceneEnvironmentDirector({
    dayNight: { enabled: true, startHour: 6, dayLengthSeconds: 240 },
  });

  assert.deepEqual(director.snapshot(), { weather: 'sunny', timeOfDay: 6, dayLength: 240 });
  for (let step = 0; step < 60; step += 1) director.advance(0.1);
  assert.ok(Math.abs(director.snapshot().timeOfDay - 6.6) < 0.001);

  // 卡顿一整秒以上也只认下一秒，天空不会瞬移。
  director.advance(30);
  assert.ok(Math.abs(director.snapshot().timeOfDay - 6.7) < 0.001);

  const frozen = new SceneEnvironmentDirector({
    dayNight: { enabled: true, paused: true, startHour: 21.5, dayLengthSeconds: 240 },
  });
  frozen.advance(10);
  assert.deepEqual(frozen.snapshot(), { weather: 'sunny', timeOfDay: 21.5, dayLength: 0 });

  const disabled = new SceneEnvironmentDirector({});
  disabled.advance(10);
  assert.deepEqual(disabled.snapshot(), {
    weather: 'sunny',
    timeOfDay: DEFAULT_START_HOUR,
    dayLength: 0,
  });
});

test('轮换只在配置的候选里切换，并且每次都换成别的天气', () => {
  const director = new SceneEnvironmentDirector({
    weather: {
      initial: 'sunny',
      cycle: { minimumSeconds: 10, maximumSeconds: 20, candidates: ['sunny', 'rain', 'snow'] },
    },
  }, { seed: 20260902 });

  const observed = new Set();
  let previous = director.weather;
  for (let step = 0; step < 400; step += 1) {
    director.advance(0.5);
    if (director.weather === previous) continue;
    assert.ok(['sunny', 'rain', 'snow'].includes(director.weather));
    observed.add(director.weather);
    previous = director.weather;
  }
  assert.ok(observed.size >= 2, `轮换应该切出多种天气，实际 ${[...observed].join('/')}`);
});

test('关掉客户端控制后，天气与时刻请求一律被拒绝', () => {
  const locked = new SceneEnvironmentDirector({
    weather: { initial: 'snow', allowPlayerControl: false },
    dayNight: { enabled: true, startHour: 2, dayLengthSeconds: 600, allowPlayerControl: false },
  });
  assert.equal(locked.requestWeather('storm'), false);
  assert.equal(locked.requestTimeOfDay(12), false);
  assert.equal(locked.weather, 'snow');
  assert.equal(locked.snapshot().timeOfDay, 2);

  const open = new SceneEnvironmentDirector({
    dayNight: { enabled: true, startHour: 2, dayLengthSeconds: 600 },
  });
  assert.equal(open.requestWeather('storm'), true);
  assert.equal(open.requestWeather('sandstorm'), false);
  assert.equal(open.requestTimeOfDay(12.25), true);
  assert.equal(open.requestTimeOfDay(24), false);
  assert.equal(open.snapshot().timeOfDay, 12.25);

  // 昼夜没启用的场景本身就没有时刻可跳。
  const frozen = new SceneEnvironmentDirector({});
  assert.equal(frozen.requestTimeOfDay(3), false);
});
