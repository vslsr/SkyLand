import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ActorCatalog } from '../actors/ActorCatalog.mjs';
import { SceneCatalog } from '../scenes/SceneCatalog.mjs';

const CONFIG_SCENES = fileURLToPath(new URL('../../config/scenes/', import.meta.url));

async function readOpenWorld() {
  return JSON.parse(await readFile(join(CONFIG_SCENES, 'open-world.scene.json'), 'utf8'));
}

/** 把一份改过的场景 JSON 单独放进临时目录里加载，只校验这一份。 */
async function loadScene(raw) {
  const directory = await mkdtemp(join(tmpdir(), 'skyland-scene-'));
  await writeFile(join(directory, 'probe.scene.json'), JSON.stringify(raw), 'utf8');
  const catalog = await SceneCatalog.load(directory, await ActorCatalog.load());
  return catalog.require(raw.id);
}

test('worldProps 把绑定关系交给场景，原型与掉落一并被带进场景', async () => {
  const scene = await loadScene(await readOpenWorld());
  assert.deepEqual(scene.gameplay.worldProps, {
    tree: [
      { archetypeId: 'generated-tree', weight: 5 },
      { archetypeId: 'fruit-tree', weight: 1 },
    ],
    rock: [{ archetypeId: 'large-rock', weight: 1 }],
    mushroom: [{ archetypeId: 'elastic-mushroom', weight: 1 }],
  });
  const ids = scene.actorArchetypes.map((archetype) => archetype.id);
  for (const id of [
    'generated-tree', 'wood-pile', 'fruit-tree', 'fruit-pile', 'large-rock', 'stone-pile',
    'elastic-mushroom',
  ]) {
    assert.ok(ids.includes(id), `${id} 应该被自动带进场景`);
  }
});

test('换一个绑定就换掉这一种物件的玩法，场景其余部分不动', async () => {
  const raw = await readOpenWorld();
  // 现成原型里只有这两个带 generatedProp；这里用 generated-rock 站位，
  // 代表「雪原地图上的树是另一个原型」这类改绑。
  raw.gameplay.worldProps = {
    tree: [{ archetype: 'generated-rock', weight: 3 }],
  };
  const scene = await loadScene(raw);
  assert.deepEqual(scene.gameplay.worldProps, {
    tree: [{ archetypeId: 'generated-rock', weight: 3 }],
  });
  const ids = scene.actorArchetypes.map((archetype) => archetype.id);
  assert.ok(ids.includes('generated-rock'));
  assert.ok(ids.includes('stone-pile'), '新绑定的掉落跟着进来');
  assert.equal(ids.includes('generated-tree'), false, '不再需要的原型不会被带进来');
});

test('worldProps 只能用在流式场景上', async () => {
  const raw = await readOpenWorld();
  delete raw.renderer.world;
  // 去掉 world 之后雾效约束也随之放开，这里只关心 worldProps 那一条。
  await assert.rejects(loadScene(raw), /worldProps 只能用在带 renderer.world 的流式场景上/);
});

test('worldProps 拒绝未知物件种类', async () => {
  const raw = await readOpenWorld();
  raw.gameplay.worldProps = {
    dragon: [{ archetype: 'generated-tree', weight: 1 }],
  };
  await assert.rejects(loadScene(raw), /不是已知物件种类/);
});

test('内容关掉的物件不能绑玩法，否则会撞得到却看不见', async () => {
  const raw = await readOpenWorld();
  raw.renderer.content.trees = false;
  await assert.rejects(loadScene(raw), /worldProps\.tree 需要开启 renderer\.content\.trees/);
});

test('worldProps 拒绝既非采集物也非弹性 Actor 的原型', async () => {
  const raw = await readOpenWorld();
  raw.gameplay.worldProps = {
    tree: [{ archetype: 'wood-pile', weight: 1 }],
  };
  await assert.rejects(loadScene(raw), /wood-pile 不是可采集生成物或可拖拽弹性 Actor/);
});

test('worldProps 拒绝不存在的原型', async () => {
  const raw = await readOpenWorld();
  raw.gameplay.worldProps = {
    tree: [{ archetype: 'no-such-archetype', weight: 1 }],
  };
  await assert.rejects(loadScene(raw), /未知 Actor 原型/);
});

test('worldProps 变体必须非空、权重有效且原型不能重复', async () => {
  const empty = await readOpenWorld();
  empty.gameplay.worldProps = { tree: [] };
  await assert.rejects(loadScene(empty), /必须是 1-16 项的原型变体数组/);

  const badWeight = await readOpenWorld();
  badWeight.gameplay.worldProps = {
    tree: [{ archetype: 'generated-tree', weight: 0 }],
  };
  await assert.rejects(loadScene(badWeight), /weight 必须是 1-1000 的整数/);

  const duplicate = await readOpenWorld();
  duplicate.gameplay.worldProps = {
    tree: [
      { archetype: 'generated-tree', weight: 1 },
      { archetype: 'generated-tree', weight: 2 },
    ],
  };
  await assert.rejects(loadScene(duplicate), /不能重复引用原型/);
});
