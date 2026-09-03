import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ContainerComponent,
  InventoryComponent,
  ItemLedger,
  NO_HOTBAR_SLOT,
  StowableComponent,
  chargeRatio,
  resolveActorAction,
  resolveHeldItemAction,
} from '../../shared/actor/index.mjs';
import { dropHeldObject, stowHeldItem, transferItems } from '../actors/InventoryMutations.mjs';

const player = (inventory) => ({ id: 'p1', getComponent: (name) => (name === 'inventory' ? inventory : undefined) });
const chest = (container) => ({ getComponent: (name) => (name === 'container' ? container : undefined) });

test('账本按货位记账，背包与容器共用同一套规则', () => {
  const ledger = new ItemLedger(2);
  // 王冠占 3 格，2 格的账本一件都放不下。
  assert.equal(ledger.add('crown-relic', 1), 0);
  assert.equal(ledger.add('wood', 150), 150);
  assert.equal(ledger.usedSlots, 2);
  assert.equal(ledger.isFull, true);
  // 满了还想收：收下 0，剩下的留在世界里而不是被吞掉。
  assert.equal(ledger.add('stone', 5), 0);
});

test('不占货位的物品不吃背包格数', () => {
  const ledger = new ItemLedger(1);
  assert.equal(ledger.add('light-ammo', 200), 200);
  assert.equal(ledger.usedSlots, 0);
  assert.equal(ledger.add('wood', 1), 1);
});

test('快捷栏存的是物品种类：用光了配置还在，补货回来自动握住', () => {
  const inventory = new InventoryComponent({ slotCapacity: 8, hotbarCapacity: 4 });
  inventory.add('wood', 2);
  assert.equal(inventory.holdItemType('wood'), true);
  assert.equal(inventory.heldItemType, 'wood');

  inventory.remove('wood', 2);
  // 货没了手就空着，但那一格仍然记着木材。
  assert.equal(inventory.heldItemType, undefined);
  assert.equal(inventory.hotbar[0], 'wood');

  inventory.add('wood', 1);
  assert.equal(inventory.heldItemType, 'wood');
});

test('同一种物品只占快捷栏一格', () => {
  const inventory = new InventoryComponent({ hotbarCapacity: 4 });
  inventory.assignHotbarSlot(0, 'wood');
  inventory.assignHotbarSlot(2, 'wood');
  assert.deepEqual(inventory.hotbar, [null, null, 'wood', null]);
});

test('再按一次当前格是收手，循环切换绕回第一格', () => {
  const inventory = new InventoryComponent({ hotbarCapacity: 3 });
  assert.equal(inventory.setActiveHotbarSlot(1), true);
  assert.equal(inventory.setActiveHotbarSlot(1), true);
  assert.equal(inventory.activeHotbarIndex, NO_HOTBAR_SLOT);
  inventory.setActiveHotbarSlot(2);
  inventory.cycleActiveHotbarSlot(1);
  assert.equal(inventory.activeHotbarIndex, 0);
  inventory.cycleActiveHotbarSlot(-1);
  assert.equal(inventory.activeHotbarIndex, 2);
});

test('快照带上快捷栏，客户端镜像跟着重建', () => {
  const server = new InventoryComponent({ hotbarCapacity: 4 });
  server.add('stone', 3);
  server.holdItemType('stone');

  const client = new InventoryComponent({ hotbarCapacity: 4 });
  assert.equal(
    client.applySnapshot(server.snapshot(), server.revision, server.hotbarSnapshot()),
    true,
  );
  assert.equal(client.heldItemType, 'stone');
  assert.equal(client.activeHotbarIndex, server.activeHotbarIndex);
  // revision 与内容都没变时不该再报一次变化，否则界面每帧重画。
  assert.equal(
    client.applySnapshot(server.snapshot(), server.revision, server.hotbarSnapshot()),
    false,
  );
});

test('手上那件不管本来是什么，交互键一律是放下', () => {
  const held = { actorId: 'a', label: '木材', action: 'pickup-stack', enabled: false, pickupHolderActorId: 'p1' };
  assert.deepEqual(resolveActorAction(held, { playerId: 'p1' }), {
    id: 'drop-held', verb: '放下「木材」', blocked: false,
  });
  // 别人手上那件不给动。
  assert.equal(resolveActorAction({ ...held, pickupHolderActorId: 'p2' }, { playerId: 'p1' }), undefined);
});

test('装卸的前置条件由动作表挡下，两端读的是同一份判定', () => {
  const crate = { actorId: 'c', label: '木箱', action: 'cargo-toggle', enabled: true, carrierActorId: null };
  assert.equal(resolveActorAction(crate, { playerId: 'p1' }).blocked, true);
  assert.equal(resolveActorAction(crate, { playerId: 'p1', controlledActorId: 'raft' }).id, 'cargo-load');
  assert.equal(
    resolveActorAction({ ...crate, carrierActorId: 'other' }, { playerId: 'p1', controlledActorId: 'raft' }).blocked,
    true,
  );
});

test('使用方式来自物品目录，点按是蓄力的退化情形', () => {
  const bomb = resolveHeldItemAction('firebomb');
  assert.equal(bomb.action, 'throw');
  assert.equal(bomb.input, 'primary');
  assert.equal(bomb.mode, 'charge');
  assert.equal(chargeRatio(bomb.chargeSeconds / 2, bomb.chargeSeconds), 0.5);
  assert.equal(chargeRatio(99, bomb.chargeSeconds), 1);

  const hammer = resolveHeldItemAction('harvest-hammer');
  assert.equal(hammer.mode, 'tap');
  // tap 的蓄力时长是 0，强度恒为满值，不需要单独一条支路。
  assert.equal(chargeRatio(0, hammer.chargeSeconds), 1);

  assert.equal(resolveHeldItemAction('medkit'), undefined);
});

test('两个人同时掏最后一摞：先到的拿走，后到的拿到 0', () => {
  const container = new ContainerComponent({ slotCapacity: 8, label: '储物箱', reach: 3 });
  container.add('stone', 5);
  const first = new InventoryComponent({ slotCapacity: 8 });
  const second = new InventoryComponent({ slotCapacity: 8 });
  const firstPlayer = { id: 'p1', getComponent: (n) => (n === 'inventory' ? first : undefined) };
  const secondPlayer = { id: 'p2', getComponent: (n) => (n === 'inventory' ? second : undefined) };
  container.openFor('p1');
  container.openFor('p2');
  const box = chest(container);

  assert.equal(transferItems(firstPlayer, box, { itemType: 'stone', quantity: 5, direction: 'withdraw' }), 5);
  assert.equal(transferItems(secondPlayer, box, { itemType: 'stone', quantity: 5, direction: 'withdraw' }), 0);
  assert.equal(first.quantityOf('stone'), 5);
  assert.equal(second.quantityOf('stone'), 0);
  assert.equal(container.quantityOf('stone'), 0);
});

test('没开着容器的人搬不动它，内容也不发给他', () => {
  const container = new ContainerComponent({ slotCapacity: 8, label: '储物箱', reach: 3 });
  container.add('wood', 4);
  const inventory = new InventoryComponent({ slotCapacity: 8 });
  assert.equal(
    transferItems(player(inventory), chest(container), { itemType: 'wood', quantity: 4, direction: 'withdraw' }),
    0,
  );
  assert.equal(container.snapshot('p1').entries, undefined);
  container.openFor('p1');
  assert.deepEqual(container.snapshot('p1').entries, [{ itemType: 'wood', quantity: 4 }]);
});

test('目标装满时差额留在来源，不会凭空消失', () => {
  const container = new ContainerComponent({ slotCapacity: 1, label: '储物箱', reach: 3 });
  const inventory = new InventoryComponent({ slotCapacity: 8 });
  inventory.add('wood', 150);
  container.openFor('p1');
  // 1 格只装得下一摞 99，剩下的 51 必须还在背包里。
  const moved = transferItems(player(inventory), chest(container), {
    itemType: 'wood', quantity: 150, direction: 'store',
  });
  assert.equal(moved + inventory.quantityOf('wood'), 150);
  assert.equal(container.quantityOf('wood'), moved);
});

test('收回背包会清掉选中格，否则长按等于没发生', () => {
  const inventory = new InventoryComponent({ slotCapacity: 8, hotbarCapacity: 4 });
  inventory.add('wood', 3);
  inventory.holdItemType('wood');
  // 权威侧拿在手上的那一个是从账本里扣掉的：账上 2，手上 1。
  inventory.remove('wood', 1);

  const heldActor = {
    id: 'held-1',
    getComponent: (name) => (name === 'itemStack' ? { itemType: 'wood', quantity: 1 } : undefined),
  };
  const pickupDrop = { heldActorId: 'held-1', drop() { this.heldActorId = null; return true; } };
  const player = {
    id: 'p1',
    getComponent: (name) => ({ inventory, pickupDrop }[name]),
  };
  const removed = [];
  heldActor.parent = { id: 'p1' };
  const scene = {
    actorWorld: {
      getActor: (id) => (id === 'held-1' ? heldActor : undefined),
      setActorParent: () => { heldActor.parent = undefined; },
    },
    removeItemStackActor: (id) => removed.push(id),
  };

  assert.equal(stowHeldItem(scene, player), true);
  assert.equal(inventory.quantityOf('wood'), 3, '手上那一个回到账本');
  assert.equal(inventory.activeHotbarIndex, NO_HOTBAR_SLOT, '收回之后是空手');
  assert.equal(inventory.hotbar[0], 'wood', '那一格的配置留着');
  assert.deepEqual(removed, ['held-1']);
});

test('背包满了收不回来时，东西留在手上而不是消失', () => {
  const inventory = new InventoryComponent({ slotCapacity: 1, hotbarCapacity: 4 });
  inventory.add('stone', 99);
  const heldActor = {
    id: 'held-2',
    parent: { id: 'p1' },
    getComponent: (name) => (name === 'itemStack' ? { itemType: 'wood', quantity: 1 } : undefined),
  };
  const pickupDrop = { heldActorId: 'held-2', drop() { this.heldActorId = null; return true; } };
  const player = { id: 'p1', getComponent: (name) => ({ inventory, pickupDrop }[name]) };
  const removed = [];
  const scene = {
    actorWorld: { getActor: () => heldActor, setActorParent: () => {} },
    removeItemStackActor: (id) => removed.push(id),
  };

  assert.equal(stowHeldItem(scene, player), false);
  assert.deepEqual(removed, [], '收不回来就不删 Actor');
  assert.equal(pickupDrop.heldActorId, 'held-2', '还拿在手上');
});

test('叼着的世界物件也能收进背包，按它自己声明的物品回账', () => {
  const inventory = new InventoryComponent({ slotCapacity: 8, hotbarCapacity: 4 });
  // 蘑菇不是物品堆：它没有 itemStack，只有 stowable 说明「装进包里算什么」。
  const stowable = new StowableComponent({ itemType: 'mushroom' });
  const mushroom = {
    id: 'm1',
    parent: { id: 'p1' },
    getComponent: (name) => (name === 'stowable' ? stowable : undefined),
  };
  const pickupDrop = { heldActorId: 'm1', drop() { this.heldActorId = null; return true; } };
  const player = { id: 'p1', getComponent: (name) => ({ inventory, pickupDrop }[name]) };
  const removed = [];
  const scene = {
    actorWorld: {
      getActor: () => mushroom,
      setActorParent: () => { mushroom.parent = undefined; },
      removeActor: (id) => removed.push(id),
    },
    removeItemStackActor: () => { throw new Error('世界物件不该走物品堆的删除'); },
  };

  assert.equal(stowHeldItem(scene, player), true);
  assert.equal(inventory.quantityOf('mushroom'), 1);
  assert.deepEqual(removed, ['m1'], '世界物件走 ActorWorld 的删除');
  assert.equal(pickupDrop.heldActorId, null, '收完是空手');
});

test('没声明 stowable 的世界物件揣不走，长按由调用方回退成放下', () => {
  const inventory = new InventoryComponent({ slotCapacity: 8 });
  const rock = { id: 'r1', parent: { id: 'p1' }, getComponent: () => undefined };
  const pickupDrop = { heldActorId: 'r1', drop() { this.heldActorId = null; return true; } };
  const player = { id: 'p1', getComponent: (name) => ({ inventory, pickupDrop }[name]) };
  const scene = {
    actorWorld: { getActor: () => rock, setActorParent: () => {}, removeActor: () => {} },
    removeItemStackActor: () => {},
  };

  assert.equal(stowHeldItem(scene, player), false);
  assert.equal(pickupDrop.heldActorId, 'r1', '收不了就原样留在手上');
});

test('放下分派：物品堆走物品的落法，世界物件走它自己的', () => {
  const inventory = new InventoryComponent({ slotCapacity: 8 });
  const mushroom = {
    id: 'm1',
    parent: { id: 'p1' },
    getComponent: () => undefined,
  };
  const pickupDrop = { heldActorId: 'm1', drop() { this.heldActorId = null; return true; } };
  const player = { id: 'p1', getComponent: (name) => ({ inventory, pickupDrop }[name]) };
  const carriedDrops = [];
  const scene = {
    actorWorld: { getActor: () => mushroom, setActorParent: () => {} },
    removeItemStackActor: () => {},
    // 蘑菇的落地要建刚体、恢复可交互、按碰撞半径推开落点，那一整套留在 ServerScene。
    dropCarriedActor: (_player, actor) => { carriedDrops.push(actor.id); return true; },
  };

  assert.equal(dropHeldObject(scene, player), true);
  assert.deepEqual(carriedDrops, ['m1'], '没有 itemStack 就交给蘑菇自己的落法');
});
