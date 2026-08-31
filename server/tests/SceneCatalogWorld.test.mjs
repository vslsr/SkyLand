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
    sceneComponents: [],
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

test('没有草地的场景不能加载鼠标草地交互组件', async () => {
  const scene = createSceneFile();
  scene.renderer.content.grass = false;
  scene.sceneComponents = [{ type: 'mouse-grass-interaction' }];
  await assert.rejects(loadSingleScene(scene), /需要开启 renderer\.content\.grass/);
});

test('场景组件拒绝未知类型、重复加载和不满足的运行前提', async () => {
  const unknown = createSceneFile();
  unknown.sceneComponents = [{ type: 'unknown-rule' }];
  await assert.rejects(loadSingleScene(unknown), /type 不受支持/);

  const duplicated = createSceneFile();
  duplicated.sceneComponents = [
    { type: 'mouse-grass-interaction' },
    { type: 'mouse-grass-interaction' },
  ];
  await assert.rejects(loadSingleScene(duplicated), /重复加载/);

  const missingPlayer = createSceneFile();
  missingPlayer.sceneComponents = [{ type: 'ability-lab' }];
  missingPlayer.camera.mode = 'fly';
  await assert.rejects(loadSingleScene(missingPlayer), /ability-lab 需要 topdown/);
});

test('Actor 父节点可后声明，且子节点坐标按局部 Transform 保留', async () => {
  const scene = createSceneFile();
  scene.actors = [
    {
      id: 'child',
      archetype: 'deck-prop',
      parentActorId: 'parent',
      localTransform: { position: [1, 2, 3], yaw: 0.2 },
    },
    {
      id: 'parent',
      archetype: 'deck-prop',
      localTransform: { position: [4, 0, 5], yaw: 0.4 },
    },
  ];
  const catalog = await loadSingleScene(scene);
  assert.deepEqual(catalog.require('streaming-probe').actors[0], {
    id: 'child',
    archetypeId: 'deck-prop',
    parentActorId: 'parent',
    localTransform: { position: [1, 2, 3], yaw: 0.2 },
  });
});

test('Actor 层级拒绝缺失父节点和循环引用', async () => {
  const missing = createSceneFile();
  missing.actors = [
    {
      id: 'child',
      archetype: 'deck-prop',
      parentActorId: 'missing',
      localTransform: { position: [0, 0, 0], yaw: 0 },
    },
  ];
  await assert.rejects(loadSingleScene(missing), /不存在的父节点/);

  const cyclic = createSceneFile();
  cyclic.actors = [
    {
      id: 'first',
      archetype: 'deck-prop',
      parentActorId: 'second',
      localTransform: { position: [0, 0, 0], yaw: 0 },
    },
    {
      id: 'second',
      archetype: 'deck-prop',
      parentActorId: 'first',
      localTransform: { position: [0, 0, 0], yaw: 0 },
    },
  ];
  await assert.rejects(loadSingleScene(cyclic), /层级存在循环/);

  const selfParented = createSceneFile();
  selfParented.actors = [{
    id: 'self',
    archetype: 'deck-prop',
    parentActorId: 'self',
    localTransform: { position: [0, 0, 0], yaw: 0 },
  }];
  await assert.rejects(loadSingleScene(selfParented), /不能将自己设为父节点/);
});
