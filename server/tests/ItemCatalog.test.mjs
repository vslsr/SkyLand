import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ItemCatalog, ITEM_CATEGORIES, itemCatalog } from '../../shared/items/index.mjs';

const ITEM_ICON_SPRITE = fileURLToPath(
  new URL('../../src/ui/icons/ItemIconSprite.ts', import.meta.url),
);

function catalogWith(...items) {
  return { schemaVersion: 1, id: 'ItemCatalog.Test', items };
}

const VALID_MATERIAL = {
  id: 'test-plank',
  displayName: '测试木板',
  category: 'material',
  stackLimit: 20,
  slotCost: 1,
  iconId: 'item-wood',
  tint: '#B98558',
  summary: '测试用材料。',
};

test('目录就是设计稿上那张物品表：木头、石头、果子、蘑菇', () => {
  assert.deepEqual(
    itemCatalog.list().map((item) => item.id),
    ['wood', 'stone', 'fruit', 'mushroom'],
  );

  // 材料只是材料：占一格、能堆、没有用法。
  for (const itemType of ['wood', 'stone']) {
    const definition = itemCatalog.require(itemType);
    assert.equal(definition.category, 'material');
    assert.equal(definition.slotCost, 1);
    assert.equal(definition.pooled, false);
    assert.equal(definition.stackLimit, 10);
    assert.equal(definition.use, undefined, `${itemType} 不能使用`);
  }

  // 补给能吃：按住嚼完那一段，一次吃掉一个。
  for (const [itemType, stackLimit] of [['fruit', 10], ['mushroom', 3]]) {
    const definition = itemCatalog.require(itemType);
    assert.equal(definition.category, 'supply');
    assert.equal(definition.stackLimit, stackLimit);
    assert.equal(definition.use.action, 'eat');
    assert.equal(definition.use.mode, 'hold');
    assert.ok(definition.use.holdSeconds > 0);
    assert.equal(definition.use.value, 1);
  }

  // 耐久现在全是 0：没有「用一次掉一点」的系统，写成别的数只会是一个空承诺。
  for (const definition of itemCatalog.list()) {
    assert.equal(definition.durability, 0, `${definition.id} 不该有耐久`);
  }
});

test('耐久是可选字段，写了就按 0-1000 的整数校验', () => {
  assert.equal(new ItemCatalog(catalogWith(VALID_MATERIAL)).require('test-plank').durability, 0);
  assert.equal(
    new ItemCatalog(catalogWith({ ...VALID_MATERIAL, durability: 120 }))
      .require('test-plank').durability,
    120,
  );
  assert.throws(
    () => new ItemCatalog(catalogWith({ ...VALID_MATERIAL, durability: -1 })),
    /durability 必须是 0-1000 的整数/,
  );
});

test('目录里每种物品都画了图标，分类枚举没有漏项', async () => {
  const sprite = await readFile(ITEM_ICON_SPRITE, 'utf8');
  for (const definition of itemCatalog.list()) {
    assert.ok(
      sprite.includes(`'${definition.iconId}':`),
      `${definition.id} 的图标 ${definition.iconId} 没有画`,
    );
  }
  const usedCategories = new Set(itemCatalog.list().map((item) => item.category));
  for (const category of usedCategories) {
    assert.ok(ITEM_CATEGORIES.includes(category), `未登记的分类：${category}`);
  }
});

test('ItemCatalog 拒绝与分类矛盾的定义', () => {
  assert.doesNotThrow(() => new ItemCatalog(catalogWith(VALID_MATERIAL)));

  assert.throws(
    () => new ItemCatalog(catalogWith({ ...VALID_MATERIAL, slotCost: 0 })),
    /slotCost 与分类不符/,
    '占货位的分类不能声明成 0 格',
  );
  assert.throws(
    () => new ItemCatalog(catalogWith({
      ...VALID_MATERIAL,
      id: 'test-ammo',
      category: 'ammunition',
      slotCost: 1,
    })),
    /slotCost 与分类不符/,
    '弹药不能吃货位',
  );
  assert.throws(
    () => new ItemCatalog(catalogWith({
      ...VALID_MATERIAL,
      id: 'test-cargo',
      category: 'valuable',
      stackLimit: 4,
      coinValue: 30,
    })),
    /不能堆叠/,
  );
  assert.throws(
    () => new ItemCatalog(catalogWith({
      ...VALID_MATERIAL,
      id: 'test-cargo',
      category: 'valuable',
      stackLimit: 1,
    })),
    /coinValue 只属于价值货物/,
    '价值货物必须标价',
  );
  assert.throws(
    () => new ItemCatalog(catalogWith({ ...VALID_MATERIAL, coinValue: 30 })),
    /coinValue 只属于价值货物/,
    '材料不该有售价',
  );
  assert.throws(
    () => new ItemCatalog(catalogWith(VALID_MATERIAL, VALID_MATERIAL)),
    /物品 id 重复/,
  );
  assert.throws(() => new ItemCatalog(catalogWith()), /至少要有一条物品定义/);
});

test('未登记的物品取不出定义', () => {
  assert.equal(itemCatalog.has('no-such-item'), false);
  assert.equal(itemCatalog.get('no-such-item'), undefined);
  assert.throws(() => itemCatalog.require('no-such-item'), /物品目录里没有登记/);
});
