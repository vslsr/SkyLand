import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SceneCatalog } from '../scenes/SceneCatalog.mjs';
import { CHUNK_SIZE, WORLD_PLAY_AREA } from '../../shared/world/worldConfig.mjs';

/**
 * 流式场景的三条约束在服务器启动时校验。
 *
 * 配错了要立刻起不来并指出是哪一项，而不是等玩家跑到世界边缘、
 * 或者眼看着地块在视野里凭空出现，才发现配置有问题。
 */
function createSceneFile(overrides = {}) {
  return {
    $schema: './scene.schema.json',
    schemaVersion: 1,
    id: 'streaming-probe',
    displayName: '流式探针',
    description: '用于校验流式场景约束的测试地图。',
    capacity: 8,
    actors: [],
    renderer: {
      type: 'line-art',
      background: '#fdfbf6',
      fog: { color: '#fdfbf6', near: 22, far: 52 },
      content: { ground: true, trees: true, grass: true, ocean: false },
      palette: {
        ground: '#f1eddf',
        grass: '#c1d7a6',
        treeTrunk: '#d6bea3',
        treeNeedles: '#cbdcbc',
      },
      world: { loadRadius: 2, keepRadius: 3, rockColor: '#d4d0c6' },
      ...overrides.renderer,
    },
    gameplay: {
      bounds: { minimumX: -192, maximumX: 192, minimumZ: -192, maximumZ: 192 },
      spawn: { centerX: 0, centerZ: 0, radius: 6, slots: 8 },
      ...overrides.gameplay,
    },
    camera: { mode: 'topdown', position: [0, 4.2, 13.5], yaw: 0, pitch: -0.12, moveSpeed: 6.5 },
  };
}

async function loadSingleScene(scene) {
  const directory = await mkdtemp(join(tmpdir(), 'skyland-scene-'));
  await writeFile(join(directory, 'probe.scene.json'), JSON.stringify(scene), 'utf8');
  return SceneCatalog.load(directory);
}

test('合法的流式场景可以加载', async () => {
  const catalog = await loadSingleScene(createSceneFile());
  assert.equal(catalog.require('streaming-probe').renderer.world.loadRadius, 2);
});

test('保留半径不大于加载半径时拒绝加载', async () => {
  const scene = createSceneFile();
  scene.renderer.world.keepRadius = 2;
  await assert.rejects(loadSingleScene(scene), /keepRadius 必须大于 loadRadius/);
});

test('雾效越过最近的未加载 chunk 时拒绝加载', async () => {
  const scene = createSceneFile();
  scene.renderer.fog.far = scene.renderer.world.loadRadius * CHUNK_SIZE + 1;
  await assert.rejects(loadSingleScene(scene), /否则视野会越过最近的未加载 chunk/);
});

test('活动范围超出流式世界的安全区时拒绝加载', async () => {
  const scene = createSceneFile();
  scene.gameplay.bounds.maximumX = WORLD_PLAY_AREA.maximumX + 1;
  await assert.rejects(loadSingleScene(scene), /超出了流式世界的活动范围/);
});

test('固定场景不受这些约束限制', async () => {
  const scene = createSceneFile();
  delete scene.renderer.world;
  scene.gameplay.bounds = { minimumX: -16, maximumX: 16, minimumZ: -21, maximumZ: 11 };
  scene.renderer.fog.far = 82;
  const catalog = await loadSingleScene(scene);
  assert.equal(catalog.require('streaming-probe').renderer.world, undefined);
});
