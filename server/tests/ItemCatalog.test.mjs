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

test('默认物品目录按分类给出携带规则', () => {
  assert.equal(itemCatalog.require('wood').category, 'material');
  assert.equal(itemCatalog.require('wood').slotCost, 1);
  assert.equal(itemCatalog.require('wood').pooled, false);

  // 弹药与基础工具不吃货位，对应设计稿 §9.5.5。
  for (const itemType of ['light-ammo', 'special-ammo', 'harvest-hammer']) {
    const definition = itemCatalog.require(itemType);
    assert.equal(definition.slotCost, 0, `${itemType} 不应该占货位`);
    assert.equal(definition.pooled, true);
  }

  // 价值货物是可抢夺实体：不堆叠、标价、大件多占货位。
  for (const definition of itemCatalog.listByCategory('valuable')) {
    assert.equal(definition.stackLimit, 1, `${definition.id} 不该堆叠`);
    assert.ok(definition.coinValue > 0, `${definition.id} 必须标价`);
    assert.ok(definition.slotCost >= 1);
  }
  assert.equal(itemCatalog.require('crown-relic').slotCost, 3);
  assert.equal(itemCatalog.require('crown-relic').contraband, true);
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
