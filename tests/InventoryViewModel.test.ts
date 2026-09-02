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

test('视图把货位、独立池和空格分开摆出来', () => {
  const view = buildInventoryView(inventoryWith(6, [
    ['wood', 12],
    ['light-ammo', 40],
    ['harvest-hammer', 1],
  ]));

  assert.equal(view.slotCapacity, 6);
  assert.equal(view.usedSlots, 1);
  assert.equal(view.freeSlots, 5, '界面按这个数量补空格');
  assert.deepEqual(view.slots.map((slot) => slot.itemType), ['wood']);
  assert.deepEqual(view.pooled.map((slot) => slot.itemType), ['light-ammo', 'harvest-hammer']);

  const wood = view.slots[0];
  assert.equal(wood.displayName, '木材');
  assert.equal(wood.categoryLabel, '材料');
  assert.equal(wood.quantity, 12);
  assert.equal(wood.stackLimit, itemCatalog.require('wood').stackLimit);
  assert.equal(wood.slotCost, 1);
  assert.equal(wood.full, false);
  assert.equal(wood.contraband, false);
  assert.equal(wood.coinValue, undefined);
  // 不占货位的东西在视图里 slotCost 恒为 0，界面因此不会给它画「几格」的角标。
  assert.equal(view.pooled[0].slotCost, 0);
});

test('价值货物汇总成待兑现金币，违禁品单独计数', () => {
  const view = buildInventoryView(inventoryWith(8, [
    ['spice-bundle', 1],
    ['crown-relic', 1],
  ]));

  const spice = itemCatalog.require('spice-bundle').coinValue;
  const crown = itemCatalog.require('crown-relic').coinValue;
  assert.equal(view.cargoValue, spice + crown);
  assert.equal(view.contrabandCount, 1);
  assert.equal(view.usedSlots, 4, '王冠遗物一件就吃掉三格');
  assert.equal(view.freeSlots, 4);
  assert.deepEqual(view.slots.map((slot) => slot.slotCost), [1, 3]);
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
