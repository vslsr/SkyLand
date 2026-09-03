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

test('一行同时给出身上和箱内，两边都能看见才谈得上决定搬哪边', () => {
  const view = buildContainerView(
    'chest-1',
    chestWith([['stone', 12]]),
    backpackWith([['stone', 3], ['wood', 5]]),
  );

  const stone = view.rows.find((row) => row.itemType === 'stone');
  assert.ok(stone);
  assert.equal(stone.carried, 3);
  assert.equal(stone.stored, 12);

  // 只在背包里的东西也要有一行，否则它没有「存」的入口。
  const wood = view.rows.find((row) => row.itemType === 'wood');
  assert.ok(wood);
  assert.equal(wood.carried, 5);
  assert.equal(wood.stored, 0);
});

test('行序和背包界面同一套：分类序在前，目录序在后', () => {
  const view = buildContainerView(
    'chest-1',
    chestWith([['light-ammo', 30], ['stone', 1]]),
    backpackWith([['fruit', 2], ['wood', 1]]),
  );
  assert.deepEqual(
    view.rows.map((row) => row.itemType),
    ['wood', 'stone', 'fruit', 'light-ammo'],
    '材料（目录序 wood → stone）→ 补给品 → 弹药',
  );
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
