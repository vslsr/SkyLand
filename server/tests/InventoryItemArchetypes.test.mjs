import assert from 'node:assert/strict';
import test from 'node:test';
import { ActorCatalog } from '../actors/ActorCatalog.mjs';
import { ServerScene } from '../scene/ServerScene.mjs';
import { SceneCatalog } from '../scenes/SceneCatalog.mjs';
import { INVENTORY_COMPONENT } from '../../shared/actor/index.mjs';
import './initRapier.mjs';

/**
 * 背包里的东西要装配到物品栏上、要丢到地上，都得先按 itemType 找到它掉在地上时用
 * 的那个原型（手持表现体裁剪的也是它）。原型不在场景表里时两条路都**静悄悄地
 * 失败**——菜单点了没反应、手上不出模型，玩家只会以为界面坏了，所以这一条按场景
 * 逐个断言。
 */
test('每张地图都带齐物品堆原型，不看这张地图长不长得出来', async () => {
  const actorCatalog = await ActorCatalog.load();
  const itemArchetypeIds = [...actorCatalog.archetypes()]
    .filter((archetype) => archetype.components.itemStack)
    .map((archetype) => archetype.id)
    .sort();
  assert.ok(itemArchetypeIds.includes('mushroom-pile'), '弹弹菇揣进包里之后要能再拿出来');

  const catalog = await SceneCatalog.load();
  for (const scene of catalog.list()) {
    const present = catalog.require(scene.id).actorArchetypes
      .filter((archetype) => archetype.components.itemStack)
      .map((archetype) => archetype.id)
      .sort();
    assert.deepEqual(present, itemArchetypeIds, `${scene.id} 缺少物品堆原型`);
  }
});

/**
 * 弹弹菇是这条路最典型的一件：它进包靠玩家自己揣，任何 worldProps 掉落都不产它，
 * 所以「只带 worldProps 掉落的原型」时，包里的蘑菇既装配不上物品栏也丢不出去。
 */
test('包里的蘑菇能装配到物品栏、拿在手上，也能直接丢到地上', async () => {
  const catalog = await SceneCatalog.load();
  const scene = new ServerScene(catalog.require('grassland'), { now: () => Date.now() });
  scene.addPlayer({ id: 'p1', name: '背包测试员', slot: 0 });
  const inventory = scene.players.get('p1').getComponent(INVENTORY_COMPONENT);
  inventory.add('mushroom', 2);

  assert.equal(
    scene.applyInventoryCommand('p1', {
      sequence: 1,
      command: { kind: 'assign', slotIndex: 0, itemType: 'mushroom' },
    }),
    true,
  );
  // 装配是一次转移：两个都搬进了物品栏那一格，背包里不再有。
  assert.equal(inventory.quantityOf('mushroom'), 0);
  assert.deepEqual(inventory.hotbar[0], { itemType: 'mushroom', quantity: 2 });

  assert.equal(
    scene.applyInventoryCommand('p1', { sequence: 2, command: { kind: 'select', slotIndex: 0 } }),
    true,
  );
  const snapshot = scene.createSnapshot('p1');
  const heldActorId = snapshot.players.find((entry) => entry.id === 'p1').heldActorId;
  assert.ok(heldActorId, '切到那一格要在手上出现模型');
  const held = snapshot.actors.find((actor) => actor.id === heldActorId);
  assert.equal(held.parentActorId, 'p1', '手上那件挂在玩家身上，坐标由 Actor 嵌套解算');
  assert.equal(held.itemStack.itemType, 'mushroom');
  // 账一直在物品栏那一格上：手上那个只是把它画出来，不额外记一份。
  assert.equal(inventory.hotbar[0].quantity, 2);

  // 「丢弃」丢的是背包里那一堆，包里已经没有了。
  inventory.add('mushroom', 1);
  assert.equal(
    scene.applyInventoryCommand('p1', { sequence: 3, command: { kind: 'drop:stack', itemType: 'mushroom' } }),
    true,
    '「丢弃」要真的丢出去',
  );
  assert.equal(inventory.quantityOf('mushroom'), 0);
});
