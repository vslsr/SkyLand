import assert from 'node:assert/strict';
import test from 'node:test';
import { buildContainerView } from '../src/inventory/index.ts';
import { ContainerComponent, InventoryComponent } from '../shared/actor/index.mjs';

function chestWith(entries: [string, number][], viewerCount = 1): ContainerComponent {
  const container = new ContainerComponent({ slotCapacity: 24, label: '储物箱', reach: 3 });
  for (const [itemType, quantity] of entries) container.add(itemType, quantity);
  container.viewerCount = viewerCount;
  return container;
}

function backpackWith(entries: [string, number][]): InventoryComponent {
  const inventory = new InventoryComponent({ slotCapacity: 8 });
  for (const [itemType, quantity] of entries) inventory.add(itemType, quantity);
  return inventory;
}

test('上半屏是箱内的每一摞，下半屏就是背包界面那一份', () => {
  const view = buildContainerView(
    'chest-1',
    chestWith([['stone', 12]]),
    backpackWith([['stone', 3], ['wood', 5]]),
  );

  // 箱内一摞一格：石头堆叠上限 10，12 个就是两格（10 + 2）。
  assert.deepEqual(
    view.stored.map((stack) => [stack.itemType, stack.quantity]),
    [['stone', 10], ['stone', 2]],
  );
  assert.equal(view.usedSlots, 2);
  assert.equal(view.freeSlots, 22, '空格子画的是「箱子还能装多少」');

  // 身上那一份原封不动就是背包界面画的那一份：同一个背包不该在两个界面里长得
  // 不一样。
  assert.deepEqual(
    view.carried?.slots.map((stack) => [stack.itemType, stack.quantity]),
    [['stone', 3], ['wood', 5]],
  );
  assert.ok(view.carried?.hotbar.length, '物品栏那一条也在，往上拖就能存进去');
});

test('箱内的顺序和背包界面同一套：分类序在前，目录序在后', () => {
  const view = buildContainerView(
    'chest-1',
    chestWith([['mushroom', 3], ['stone', 1], ['fruit', 2], ['wood', 1]]),
    undefined,
  );
  assert.deepEqual(
    view.stored.map((stack) => stack.itemType),
    ['wood', 'stone', 'fruit', 'mushroom'],
    '材料（目录序 wood → stone）→ 补给（目录序 fruit → mushroom）',
  );
  assert.equal(view.carried, undefined, '没有角色时下半屏什么都不画');
});

test('自己不算在「另有几个人」里', () => {
  assert.equal(buildContainerView('c', chestWith([], 1), undefined).otherViewerCount, 0);
  assert.equal(buildContainerView('c', chestWith([], 3), undefined).otherViewerCount, 2);
});

test('客户端镜像跟随快照；收不到内容时保留上一次，不闪成空列表', () => {
  const server = new ContainerComponent({ slotCapacity: 24, label: '储物箱', reach: 3 });
  server.add('wood', 7);
  server.openFor('p1');

  const client = new ContainerComponent({ slotCapacity: 24, label: '储物箱', reach: 3 });
  assert.equal(client.applySnapshot(server.snapshot('p1')), true);
  assert.equal(client.quantityOf('wood'), 7);
  assert.equal(client.openForViewer, true);

  // 关箱子那一帧内容会停发：清空会让界面在关闭动画里闪一下空列表。
  server.closeFor('p1');
  client.applySnapshot(server.snapshot('p1'));
  assert.equal(client.openForViewer, false);
  assert.equal(client.quantityOf('wood'), 7, '内容留着');
});
