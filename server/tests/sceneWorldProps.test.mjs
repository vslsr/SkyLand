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
  assert.deepEqual(scene.gameplay.worldProps, { tree: 'generated-tree', rock: 'generated-rock' });
  const ids = scene.actorArchetypes.map((archetype) => archetype.id);
  for (const id of ['generated-tree', 'wood-pile', 'generated-rock', 'stone-pile']) {
    assert.ok(ids.includes(id), `${id} 应该被自动带进场景`);
  }
});

test('换一个绑定就换掉这一种物件的玩法，场景其余部分不动', async () => {
  const raw = await readOpenWorld();
  // 现成原型里只有这两个带 generatedProp；这里用 generated-rock 站位，
  // 代表「雪原地图上的树是另一个原型」这类改绑。
  raw.gameplay.worldProps = { tree: 'generated-rock' };
  const scene = await loadScene(raw);
  assert.deepEqual(scene.gameplay.worldProps, { tree: 'generated-rock' });
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
  raw.gameplay.worldProps = { dragon: 'generated-tree' };
  await assert.rejects(loadScene(raw), /不是已知物件种类/);
});

test('内容关掉的物件不能绑玩法，否则会撞得到却看不见', async () => {
  const raw = await readOpenWorld();
  raw.renderer.content.trees = false;
  await assert.rejects(loadScene(raw), /worldProps\.tree 需要开启 renderer\.content\.trees/);
});

test('worldProps 拒绝没有 generatedProp 的原型', async () => {
  const raw = await readOpenWorld();
  raw.gameplay.worldProps = { tree: 'wood-pile' };
  await assert.rejects(loadScene(raw), /wood-pile 缺少 generatedProp/);
});

test('worldProps 拒绝不存在的原型', async () => {
  const raw = await readOpenWorld();
  raw.gameplay.worldProps = { tree: 'no-such-archetype' };
  await assert.rejects(loadScene(raw), /未知 Actor 原型/);
});
