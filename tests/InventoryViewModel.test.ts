import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildInventoryView,
  ITEM_CATEGORY_LABELS,
  type InventoryModelLike,
} from '../src/inventory/index.ts';
import { InventoryComponent } from '../shared/actor/index.mjs';
import { ITEM_CATEGORIES, itemCatalog } from '../shared/items/index.mjs';

function inventoryWith(slotCapacity: number, entries: [string, number][]): InventoryModelLike {
  const inventory = new InventoryComponent({ slotCapacity });
  for (const [itemType, quantity] of entries) inventory.add(itemType, quantity);
  return inventory as unknown as InventoryModelLike;
}

test('分类标签覆盖物品目录里的每一种分类', () => {
  assert.deepEqual(
    Object.keys(ITEM_CATEGORY_LABELS).sort(),
    [...ITEM_CATEGORIES].sort(),
    'TS 侧的分类联合类型和 JSON 枚举必须一致',
  );
});

test('视图把货位和空格分开摆出来', () => {
  const view = buildInventoryView(inventoryWith(6, [
    ['wood', 4],
    ['fruit', 2],
  ]));

  assert.equal(view.slotCapacity, 6);
  assert.equal(view.usedSlots, 2);
  assert.equal(view.freeSlots, 4, '界面按这个数量补空格');
  assert.deepEqual(view.slots.map((slot) => slot.itemType), ['wood', 'fruit']);
  assert.deepEqual(view.pooled, [], '四件物品都占货位，独立池是空的');

  const wood = view.slots[0];
  assert.equal(wood.displayName, '木头');
  assert.equal(wood.categoryLabel, '材料');
  assert.equal(wood.quantity, 4);
  assert.equal(wood.stackLimit, itemCatalog.require('wood').stackLimit);
  assert.equal(wood.slotCost, 1);
  assert.equal(wood.full, false);
  assert.equal(wood.contraband, false);
  assert.equal(wood.coinValue, undefined);
  assert.equal(wood.usable, false, '木头不能使用');

  const fruit = view.slots[1];
  assert.equal(fruit.usable, true);
  assert.equal(fruit.useMode, 'hold', '果子要按住嚼完那一段才吃下去');
  assert.ok(fruit.holdSeconds > 0);
});

test('堆到上限的格子标成 full，装满时没有空格', () => {
  const stackLimit = itemCatalog.require('fruit').stackLimit;
  const view = buildInventoryView(inventoryWith(1, [['fruit', stackLimit]]));
  assert.equal(view.slots[0].full, true);
  assert.equal(view.freeSlots, 0);
});

test('目录里查不到的物品不进视图', () => {
  const view = buildInventoryView({
    slotCapacity: 4,
    usedSlots: 1,
    revision: 3,
    slots: [{ itemType: 'ghost-item', quantity: 2 }, { itemType: 'stone', quantity: 5 }],
    pooled: [],
  });
  assert.deepEqual(view.slots.map((slot) => slot.itemType), ['stone']);
  assert.equal(view.usedSlots, 1, '货位数按画得出来的格子重算');
  assert.equal(view.revision, 3);
});
