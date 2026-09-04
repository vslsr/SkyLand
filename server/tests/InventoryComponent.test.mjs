import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SLOT_CAPACITY,
  InventoryComponent,
} from '../../shared/actor/index.mjs';
import { itemCatalog } from '../../shared/items/index.mjs';

/**
 * 一份**加料的物品目录**：四件正式物品之外，再补两条只在这个文件里存在的定义。
 *
 * 目录现在只有木头、石头、果子、蘑菇，四件都占一格、都能堆叠。而「一件吃掉三个
 * 货位」和「不占货位的独立池」是账本本来就守的规则，不该因为目录里暂时没有这样
 * 的物品就没人钉住——那样等这类物品回到目录时，规则已经在某次重构里悄悄没了。
 */
const EXTRA_ITEMS = new Map([
  ['crown-relic', Object.freeze({
    id: 'crown-relic', displayName: '王冠遗物', category: 'valuable',
    stackLimit: 1, slotCost: 3, pooled: false,
  })],
  ['ancient-coin-case', Object.freeze({
    id: 'ancient-coin-case', displayName: '古币匣', category: 'valuable',
    stackLimit: 1, slotCost: 2, pooled: false,
  })],
  ['light-ammo', Object.freeze({
    id: 'light-ammo', displayName: '普通弹药', category: 'ammunition',
    stackLimit: 240, slotCost: 0, pooled: true,
  })],
]);

const extendedCatalog = {
  get: (itemType) => EXTRA_ITEMS.get(itemType) ?? itemCatalog.get(itemType),
  has: (itemType) => EXTRA_ITEMS.has(itemType) || itemCatalog.has(itemType),
  require: (itemType) => {
    const definition = EXTRA_ITEMS.get(itemType) ?? itemCatalog.get(itemType);
    if (!definition) throw new Error(`物品目录里没有登记：${itemType}`);
    return definition;
  },
};

test('同类物品先填满已有堆叠，再另开货位', () => {
  const inventory = new InventoryComponent({ slotCapacity: 4 });
  const stackLimit = itemCatalog.require('wood').stackLimit;

  assert.equal(inventory.add('wood', 3), 3);
  assert.equal(inventory.slots.length, 1, '第二次拾取不该另开一格');
  assert.equal(inventory.add('wood', 2), 2);
  assert.equal(inventory.slots.length, 1);
  assert.equal(inventory.quantityOf('wood'), 5);
  assert.equal(inventory.usedSlots, 1);

  // 一格堆到上限之后才开新格。
  assert.equal(inventory.add('wood', stackLimit), stackLimit);
  assert.equal(inventory.slots.length, 2);
  assert.equal(inventory.slots[0].quantity, stackLimit);
  assert.equal(inventory.quantityOf('wood'), 5 + stackLimit);
});

test('货位装满后拒收，剩下的留在世界里', () => {
  const inventory = new InventoryComponent({ slotCapacity: 2 });
  const limit = itemCatalog.require('mushroom').stackLimit;
  assert.equal(inventory.add('mushroom', limit), limit);
  assert.equal(inventory.add('mushroom', limit), limit, '堆到上限就另开一格');
  assert.equal(inventory.slots.length, 2);
  assert.equal(inventory.freeSlots, 0);
  assert.equal(inventory.isFull, true);

  const revision = inventory.revision;
  assert.equal(inventory.add('wood', 20), 0, '满了就一个也收不下');
  assert.equal(inventory.revision, revision, '没收下东西不该产生复制修订');
});

test('大件货物按 slotCost 吃掉多个货位', () => {
  const inventory = new InventoryComponent({ slotCapacity: 4 }, extendedCatalog);
  assert.equal(extendedCatalog.require('crown-relic').slotCost, 3);

  assert.equal(inventory.add('crown-relic', 1), 1);
  assert.equal(inventory.usedSlots, 3);
  assert.equal(inventory.freeSlots, 1);
  assert.equal(inventory.add('ancient-coin-case', 1), 0, '剩一格装不下两格的箱子');
  assert.equal(inventory.add('stone', 3), 3, '一格的东西还塞得进去');
  assert.equal(inventory.usedSlots, 4);
});

test('不占货位的物品走独立池，但各自有上限', () => {
  const inventory = new InventoryComponent({ slotCapacity: 1 }, extendedCatalog);
  const limit = extendedCatalog.require('light-ammo').stackLimit;

  assert.equal(inventory.add('light-ammo', limit + 50), limit, '超过上限的部分不拾取');
  assert.equal(inventory.usedSlots, 0, '弹药不该挤压货位');
  assert.equal(inventory.freeSlots, 1);
  assert.equal(inventory.pooled.length, 1);

  // 货位还能照常收占格的东西。
  assert.equal(inventory.add('wood', 5), 5);
  assert.equal(inventory.usedSlots, 1);
});

test('取出物品会清空空掉的货位，未登记的物品收不下', () => {
  const inventory = new InventoryComponent({ slotCapacity: 4 }, extendedCatalog);
  inventory.add('stone', 8);
  inventory.add('light-ammo', 40);

  assert.equal(inventory.remove('stone', 5), 5);
  assert.equal(inventory.quantityOf('stone'), 3);
  assert.equal(inventory.slots.length, 1);
  assert.equal(inventory.remove('stone', 999), 3, '取多了只取得到剩下的');
  assert.equal(inventory.slots.length, 0, '空掉的货位要还回去');
  assert.equal(inventory.remove('light-ammo', 40), 40);
  assert.equal(inventory.pooled.length, 0);

  assert.equal(inventory.add('no-such-item', 3), 0);
  assert.equal(inventory.add('wood', 0), 0);
  assert.equal(inventory.add('wood', -5), 0);
});

test('快照按货位顺序发，客户端镜像能原样还原', () => {
  const authority = new InventoryComponent({ slotCapacity: 6 }, extendedCatalog);
  authority.add('wood', 4);
  authority.add('stone', 7);
  authority.add('light-ammo', 30);

  assert.deepEqual(authority.snapshot(), [
    { itemType: 'wood', quantity: 4 },
    { itemType: 'stone', quantity: 7 },
    { itemType: 'light-ammo', quantity: 30 },
  ]);

  const mirror = new InventoryComponent({ slotCapacity: 6 }, extendedCatalog);
  assert.equal(mirror.applySnapshot(authority.snapshot(), authority.revision), true);
  assert.deepEqual(mirror.snapshot(), authority.snapshot());
  assert.equal(mirror.revision, authority.revision);
  assert.equal(mirror.usedSlots, 2, '弹药在镜像里同样不占货位');
  assert.equal(mirror.pooled.length, 1);

  // 同一份快照重复到达不算变化，界面不用重画。
  assert.equal(mirror.applySnapshot(authority.snapshot(), authority.revision), false);
  authority.add('stone', 1);
  assert.equal(mirror.applySnapshot(authority.snapshot(), authority.revision), true);
  assert.equal(mirror.quantityOf('stone'), 8);
});

test('镜像丢掉快照里没登记的条目，不写坏本地货位', () => {
  const mirror = new InventoryComponent({ slotCapacity: 4 });
  mirror.applySnapshot([
    { itemType: 'wood', quantity: 3 },
    { itemType: 'ghost-item', quantity: 9 },
    { itemType: 'stone', quantity: 0 },
  ], 7);
  assert.deepEqual(mirror.snapshot(), [{ itemType: 'wood', quantity: 3 }]);
  assert.equal(mirror.revision, 7);
});

test('原型没写货位数时用默认容量', () => {
  assert.equal(new InventoryComponent().slotCapacity, DEFAULT_SLOT_CAPACITY);
  assert.equal(new InventoryComponent({ slotCapacity: 0 }).slotCapacity, DEFAULT_SLOT_CAPACITY);
  assert.equal(new InventoryComponent({ slotCapacity: 3 }).slotCapacity, 3);
});

test('拾取的落点顺序：先手上、再物品栏空位、最后背包', () => {
  const limit = itemCatalog.require('wood').stackLimit;
  const inventory = new InventoryComponent({ slotCapacity: 2, hotbarCapacity: 3 });

  // 空手捡起来的东西直接到手上：落进空着的那一格，并且当场就握着。
  assert.equal(inventory.receive('wood', 2), 2);
  assert.deepEqual(inventory.hotbar[0], { itemType: 'wood', quantity: 2 });
  assert.equal(inventory.heldItemType, 'wood', '空手捡东西就该拿在手上');
  assert.deepEqual(inventory.snapshot(), [], '物品栏装得下就轮不到背包');

  // 同一种先堆在已经装着它的那一格上，堆满才另找空格。
  assert.equal(inventory.receive('wood', limit), limit);
  assert.equal(inventory.hotbar[0].quantity, limit);
  assert.equal(inventory.hotbar[1].quantity, 2);

  // 手上握着别的东西时不换手：一次拾取不该把玩家正拿着的那件顶掉。
  assert.equal(inventory.receive('stone', 1), 1);
  assert.equal(inventory.heldItemType, 'wood');
  assert.equal(inventory.hotbar[2].itemType, 'stone');

  // 物品栏满了才落背包。
  assert.equal(inventory.receive('fruit', 3), 3);
  assert.deepEqual(inventory.snapshot(), [{ itemType: 'fruit', quantity: 3 }]);
});

test('拾取收不下的部分留在世界里，两本账都满时一个都不收', () => {
  const limit = itemCatalog.require('stone').stackLimit;
  const inventory = new InventoryComponent({ slotCapacity: 1, hotbarCapacity: 1 });

  // 物品栏一格 + 背包一格，一共装得下两摞；多出来的那一个收不下。
  assert.equal(inventory.receive('stone', limit * 2 + 1), limit * 2);
  assert.equal(inventory.hotbar[0].quantity, limit);
  assert.equal(inventory.quantityOf('stone'), limit);

  const revision = inventory.revision;
  assert.equal(inventory.receive('stone', 5), 0, '两本账都满了就一个都收不下');
  assert.equal(inventory.revision, revision, '没收下东西不该产生复制修订');
  assert.equal(inventory.receive('no-such-item', 3), 0);
});
