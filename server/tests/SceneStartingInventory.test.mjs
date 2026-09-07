import './initRapier.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SceneCatalog } from '../scenes/SceneCatalog.mjs';
import { ServerScene } from '../scene/ServerScene.mjs';
import { INVENTORY_COMPONENT, NO_HOTBAR_SLOT } from '../../shared/actor/index.mjs';

/**
 * `gameplay.startingInventory` 的两个落点。
 *
 * 「发到背包里」和「摆进物品栏那一格」是同一张表的两种写法，差别只有 `hotbarSlot`；
 * 装进物品栏是一次真实的转移，所以发下去的那一件不会在背包里再留一份。
 */

const catalogPromise = SceneCatalog.load();

const openWorldFilePromise = readFile(
  new URL('../../config/scenes/open-world.scene.json', import.meta.url),
  'utf8',
).then((text) => JSON.parse(text));

/** 照大世界那张图改一份起始物品表，单独加载：配置错了要在加载时就说出来。 */
async function loadWithStartingInventory(startingInventory) {
  const scene = structuredClone(await openWorldFilePromise);
  scene.gameplay.startingInventory = startingInventory;
  const directory = await mkdtemp(join(tmpdir(), 'skyland-starting-'));
  await writeFile(join(directory, 'probe.scene.json'), JSON.stringify(scene), 'utf8');
  return SceneCatalog.load(directory);
}

function joinScene(definition) {
  const scene = new ServerScene(definition, { now: () => 1_000_000 });
  scene.addPlayer({ id: 'wanderer', name: '旅人', slot: 0 });
  return scene.players.get('wanderer').requireComponent(INVENTORY_COMPONENT);
}

test('大世界开局：物品栏第一格摆着一把弹弓', async () => {
  const catalog = await catalogPromise;
  const definition = catalog.require('open-world');
  assert.deepEqual(definition.gameplay.startingInventory, [
    { itemType: 'slingshot', quantity: 1, hotbarSlot: 0 },
  ]);

  const inventory = joinScene(definition);
  assert.deepEqual(inventory.hotbar[0], { itemType: 'slingshot', quantity: 1 });
  assert.equal(inventory.quantityOf('slingshot'), 0, '装配是一次转移，背包里不该还有一把');
  assert.equal(inventory.totalQuantityOf('slingshot'), 1, '身上一共就这一把');
  assert.equal(inventory.activeHotbarIndex, NO_HOTBAR_SLOT, '开局仍是空手，切过去由玩家自己按');
});

test('不写格号的那一条照旧发到背包里', async () => {
  const catalog = await loadWithStartingInventory([{ itemType: 'wood', quantity: 4 }]);
  const inventory = joinScene(catalog.require('open-world'));
  assert.equal(inventory.quantityOf('wood'), 4);
  assert.deepEqual(inventory.hotbar.filter((slot) => slot !== null), [], '没写格号就不进物品栏');
});

test('物品栏格号越界、撞格、同种物品重复都在加载时拒绝', async () => {
  await assert.rejects(
    loadWithStartingInventory([{ itemType: 'slingshot', quantity: 1, hotbarSlot: 9 }]),
    /hotbarSlot 必须是 0-8 的整数/,
  );
  await assert.rejects(
    loadWithStartingInventory([
      { itemType: 'slingshot', quantity: 1, hotbarSlot: 0 },
      { itemType: 'wood-bow', quantity: 1, hotbarSlot: 0 },
    ]),
    /hotbarSlot 和前面一条撞了：0/,
  );
  await assert.rejects(
    loadWithStartingInventory([
      { itemType: 'wood', quantity: 4 },
      { itemType: 'wood', quantity: 4, hotbarSlot: 0 },
    ]),
    /itemType 重复：wood/,
  );
});

test('一格物品栏装不下的数量在加载时拒绝', async () => {
  // 弹弓一格一把：写 2 的那份配置发下去只会有一把进物品栏，另一把静悄悄留在背包里。
  await assert.rejects(
    loadWithStartingInventory([{ itemType: 'slingshot', quantity: 2, hotbarSlot: 0 }]),
    /超过 slingshot 的堆叠上限 1/,
  );
});
