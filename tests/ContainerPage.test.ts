import assert from 'node:assert/strict';
import test from 'node:test';
import { ContainerPage, type ContainerTransferRequest } from '../src/ui/pages/ContainerPage.ts';
import { buildContainerView } from '../src/inventory/index.ts';
import { ContainerComponent, InventoryComponent } from '../shared/actor/index.mjs';
import { FakeElement, withFakeDocument } from './fakeDom.ts';

/**
 * 容器界面。
 *
 * 这一层测的是**同一种格子**这件事：上半屏箱内、下半屏背包 + 物品栏，画的是和背包
 * 界面完全一样的 `inventory__cell`，搬东西就是把一格拖到另一片上。
 */

function chestWith(entries: [string, number][]): ContainerComponent {
  const container = new ContainerComponent({ slotCapacity: 24, label: '储物箱', reach: 3 });
  for (const [itemType, quantity] of entries) container.add(itemType, quantity);
  container.viewerCount = 1;
  return container;
}

function backpackWith(entries: [string, number][]): InventoryComponent {
  const inventory = new InventoryComponent({ slotCapacity: 8, hotbarCapacity: 9 });
  for (const [itemType, quantity] of entries) inventory.add(itemType, quantity);
  return inventory;
}

function cellsOf(page: ContainerPage, className: string): FakeElement[] {
  const root = page.element as unknown as FakeElement;
  return root.collect((element) => element.className.split(' ').includes(className));
}

function gridOf(page: ContainerPage, label: string): FakeElement {
  const root = page.element as unknown as FakeElement;
  const grid = root.collect((element) => element.getAttribute('aria-label') === label)[0];
  assert.ok(grid, `没有「${label}」那一片`);
  return grid;
}

test('两片格子：上半屏箱内、下半屏背包，用的是和背包界面同一种格子', () => {
  withFakeDocument(() => {
    const page = new ContainerPage();
    const inventory = backpackWith([['wood', 5]]);
    inventory.assignHotbarSlot(0, 'wood');
    inventory.add('stone', 2);
    page.setContainer(buildContainerView('chest-1', chestWith([['fruit', 3]]), inventory));

    const stored = gridOf(page, '箱内');
    assert.equal(stored.children[0]?.dataset.itemType, 'fruit');
    // 空格子画的是「箱子还能装多少」——一格果子占掉一格，24 格里还剩 23 格。
    assert.equal(stored.children.length, 24);

    const backpack = gridOf(page, '背包');
    assert.deepEqual(
      backpack.children.filter((cell) => cell.dataset.itemType).map((cell) => cell.dataset.itemType),
      ['stone'],
      '木头已经装配到物品栏上了，背包里只剩石头',
    );

    // 三片用的是同一个 `inventory__cell`，物品栏那一条还多一个 --hotbar 记号。
    assert.ok(cellsOf(page, 'inventory__cell').length > 24);
    assert.equal(cellsOf(page, 'inventory__cell--hotbar')[0]?.dataset.itemType, 'wood');

    assert.equal(
      cellsOf(page, 'container__capacity')[0]?.textContent,
      '箱内货位 1 / 24',
    );
  });
});

test('把一格拖到另一片上就是搬：方向由它在哪一片上决定', () => {
  withFakeDocument(() => {
    const page = new ContainerPage();
    const requests: ContainerTransferRequest[] = [];
    page.onTransfer((request) => requests.push(request));
    const inventory = backpackWith([['stone', 6]]);
    page.setContainer(buildContainerView('chest-1', chestWith([['wood', 4]]), inventory));

    const backpack = gridOf(page, '背包');
    const stored = gridOf(page, '箱内');
    const stone = backpack.children.find((cell) => cell.dataset.itemType === 'stone');
    const wood = stored.children.find((cell) => cell.dataset.itemType === 'wood');
    assert.ok(stone && wood);

    stone.dispatchEvent(new Event('dragstart'));
    stored.dispatchEvent(new Event('drop'));
    assert.deepEqual(requests.at(-1), {
      slot: { kind: 'backpack', itemType: 'stone' },
      quantity: 6,
      direction: 'store',
    });

    wood.dispatchEvent(new Event('dragstart'));
    backpack.dispatchEvent(new Event('drop'));
    assert.deepEqual(requests.at(-1), {
      slot: { kind: 'container', itemType: 'wood' },
      quantity: 4,
      direction: 'withdraw',
    });

    // 拖回自己那一片什么都不做：这两片里的顺序都是自动排的。
    const before = requests.length;
    wood.dispatchEvent(new Event('dragstart'));
    stored.dispatchEvent(new Event('drop'));
    assert.equal(requests.length, before);
  });
});

test('点一格弹出的菜单只有一条，方向和拖拽说的是同一件事', () => {
  withFakeDocument(() => {
    const page = new ContainerPage();
    const requests: ContainerTransferRequest[] = [];
    page.onTransfer((request) => requests.push(request));
    const inventory = backpackWith([['fruit', 2]]);
    inventory.assignHotbarSlot(3, 'fruit');
    page.setContainer(buildContainerView('chest-1', chestWith([['wood', 4]]), inventory));

    // 物品栏那一格也存得进去：它是一本独立的账，搬的是「第几格」。
    const hotbarCell = cellsOf(page, 'inventory__cell--hotbar')[3];
    assert.equal(hotbarCell?.dataset.itemType, 'fruit');
    hotbarCell.dispatchEvent(new Event('click'));
    const entries = cellsOf(page, 'inventory-menu__entry');
    assert.deepEqual(entries.map((entry) => entry.textContent), ['存入']);
    entries[0].dispatchEvent(new Event('click'));
    assert.deepEqual(requests.at(-1), {
      slot: { kind: 'hotbar', slotIndex: 3 },
      quantity: 2,
      direction: 'store',
    });

    const wood = gridOf(page, '箱内').children.find((cell) => cell.dataset.itemType === 'wood');
    assert.ok(wood);
    wood.dispatchEvent(new Event('click'));
    assert.deepEqual(
      cellsOf(page, 'inventory-menu__entry').map((entry) => entry.textContent),
      ['取出'],
      '箱内那一格只能取出：方向由它在哪一片上决定',
    );
  });
});

test('箱子满了，「存入」列出来但点不动', () => {
  withFakeDocument(() => {
    const page = new ContainerPage();
    const small = new ContainerComponent({ slotCapacity: 1, label: '储物箱', reach: 3 });
    small.add('wood', 10);
    small.viewerCount = 1;
    page.setContainer(buildContainerView('chest-1', small, backpackWith([['stone', 2]])));

    const stone = gridOf(page, '背包').children.find((cell) => cell.dataset.itemType === 'stone');
    assert.ok(stone);
    stone.dispatchEvent(new Event('click'));
    const entry = cellsOf(page, 'inventory-menu__entry')[0];
    assert.equal(entry?.textContent, '存入');
    assert.equal(entry?.disabled, true);
  });
});

test('没有权威数据时只留一句空态，不画半屏空格子', () => {
  withFakeDocument(() => {
    const page = new ContainerPage();
    page.setContainer(undefined);
    assert.equal(cellsOf(page, 'container__empty-notice')[0]?.hidden, false);
    assert.equal(gridOf(page, '箱内').children.length, 0);
    assert.equal(cellsOf(page, 'container__store-all')[0]?.disabled, true);
  });
});
