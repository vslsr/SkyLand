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

test('弹药位摊成界面画得出来的一份：名字、图标、还剩几发、装得下几发', () => {
  const inventory = new InventoryComponent({ slotCapacity: 6, hotbarCapacity: 9 });
  inventory.add('slingshot', 1);
  inventory.add('stone', 4);

  // 没装的时候不该冒出一个「0 发」的视图：格子上那个小框据此决定画不画。
  const empty = buildInventoryView(inventory as unknown as InventoryModelLike);
  const before = empty.pooled.find((stack) => stack.itemType === 'slingshot');
  assert.deepEqual(before?.ammoSlot, { accepts: ['stone'], capacity: 5 });
  assert.equal(before?.ammo, undefined);

  inventory.loadAmmo(
    { kind: 'backpack', itemType: 'slingshot' },
    { kind: 'backpack', itemType: 'stone' },
    3,
  );
  inventory.assignHotbarSlot(0, 'slingshot');
  const view = buildInventoryView(inventory as unknown as InventoryModelLike);

  // 弹药自己的名字与图标照样从物品目录查：那个小框画的是一件物品，不是一个数字。
  assert.deepEqual(view.hotbar[0]?.ammo, {
    itemType: 'stone',
    quantity: 3,
    displayName: itemCatalog.require('stone').displayName,
    iconId: itemCatalog.require('stone').iconId,
    tint: itemCatalog.require('stone').tint,
    capacity: 5,
  });
});
