import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SLOT_CAPACITY,
  InventoryComponent,
} from '../../shared/actor/index.mjs';
import { itemCatalog } from '../../shared/items/index.mjs';

test('同类物品先填满已有堆叠，再另开货位', () => {
  const inventory = new InventoryComponent({ slotCapacity: 4 });
  const stackLimit = itemCatalog.require('wood').stackLimit;

  assert.equal(inventory.add('wood', 10), 10);
  assert.equal(inventory.slots.length, 1, '第二次拾取不该另开一格');
  assert.equal(inventory.add('wood', 5), 5);
  assert.equal(inventory.slots.length, 1);
  assert.equal(inventory.quantityOf('wood'), 15);
  assert.equal(inventory.usedSlots, 1);

  // 一格堆到上限之后才开新格。
  assert.equal(inventory.add('wood', stackLimit), stackLimit);
  assert.equal(inventory.slots.length, 2);
  assert.equal(inventory.slots[0].quantity, stackLimit);
  assert.equal(inventory.quantityOf('wood'), 15 + stackLimit);
});

test('货位装满后拒收，剩下的留在世界里', () => {
  const inventory = new InventoryComponent({ slotCapacity: 2 });
  assert.equal(inventory.add('spice-bundle', 1), 1);
  assert.equal(inventory.add('spice-bundle', 1), 1, '不堆叠的货物各占一格');
  assert.equal(inventory.slots.length, 2);
  assert.equal(inventory.freeSlots, 0);
  assert.equal(inventory.isFull, true);

  const revision = inventory.revision;
  assert.equal(inventory.add('wood', 20), 0, '满了就一个也收不下');
  assert.equal(inventory.revision, revision, '没收下东西不该产生复制修订');
});

test('大件货物按 slotCost 吃掉多个货位', () => {
  const inventory = new InventoryComponent({ slotCapacity: 4 });
  assert.equal(itemCatalog.require('crown-relic').slotCost, 3);

  assert.equal(inventory.add('crown-relic', 1), 1);
  assert.equal(inventory.usedSlots, 3);
  assert.equal(inventory.freeSlots, 1);
  assert.equal(inventory.add('ancient-coin-case', 1), 0, '剩一格装不下两格的箱子');
  assert.equal(inventory.add('stone', 30), 30, '一格的东西还塞得进去');
  assert.equal(inventory.usedSlots, 4);
});

test('弹药与基础工具不吃货位，但各自有上限', () => {
  const inventory = new InventoryComponent({ slotCapacity: 1 });
  const limit = itemCatalog.require('light-ammo').stackLimit;

  assert.equal(inventory.add('light-ammo', limit + 50), limit, '超过上限的部分不拾取');
  assert.equal(inventory.usedSlots, 0, '弹药不该挤压货位');
  assert.equal(inventory.freeSlots, 1);
  assert.equal(inventory.pooled.length, 1);
  assert.equal(inventory.add('harvest-hammer', 1), 1);
  assert.equal(inventory.pooled.length, 2);
  assert.equal(inventory.usedSlots, 0);

  // 货位还能照常收占格的东西。
  assert.equal(inventory.add('wood', 5), 5);
  assert.equal(inventory.usedSlots, 1);
});

test('取出物品会清空空掉的货位，未登记的物品收不下', () => {
  const inventory = new InventoryComponent({ slotCapacity: 4 });
  inventory.add('stone', 30);
  inventory.add('light-ammo', 40);

  assert.equal(inventory.remove('stone', 12), 12);
  assert.equal(inventory.quantityOf('stone'), 18);
  assert.equal(inventory.slots.length, 1);
  assert.equal(inventory.remove('stone', 999), 18, '取多了只取得到剩下的');
  assert.equal(inventory.slots.length, 0, '空掉的货位要还回去');
  assert.equal(inventory.remove('light-ammo', 40), 40);
  assert.equal(inventory.pooled.length, 0);

  assert.equal(inventory.add('no-such-item', 3), 0);
  assert.equal(inventory.add('wood', 0), 0);
  assert.equal(inventory.add('wood', -5), 0);
});

test('快照按货位顺序发，客户端镜像能原样还原', () => {
  const authority = new InventoryComponent({ slotCapacity: 6 });
  authority.add('wood-log', 4);
  authority.add('stone', 7);
  authority.add('light-ammo', 30);

  assert.deepEqual(authority.snapshot(), [
    { itemType: 'wood-log', quantity: 4 },
    { itemType: 'stone', quantity: 7 },
    { itemType: 'light-ammo', quantity: 30 },
  ]);

  const mirror = new InventoryComponent({ slotCapacity: 6 });
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
