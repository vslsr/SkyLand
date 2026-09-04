import assert from 'node:assert/strict';
import test from 'node:test';

import { ServerScene } from '../scene/ServerScene.mjs';
import { SceneCatalog } from '../scenes/SceneCatalog.mjs';
import {
  INVENTORY_COMPONENT,
  ITEM_STACK_COMPONENT,
  PICKUP_DROP_COMPONENT,
} from '../../shared/actor/index.mjs';
import { registerItemUseAction } from '../actors/ItemUseActions.mjs';
import { unregisterShootAction } from '../actors/WeaponRuntime.mjs';
import { itemUseCooldownRemaining } from '../actors/ItemAbilityRuntime.mjs';
import './initRapier.mjs';

/**
 * 物品系统交给**武器系统**的那份接口。
 *
 * 弹弓这件东西在这里是完整的：装得进石头、蓄得了力、有冷却、扣得掉弹药。唯独
 * 「打出去的是什么」不在这里——那由武器系统注册一条 `shoot` 执行器兑现，物品
 * 系统只把这一次激活连同蓄了几成、以及扣弹药的手柄交出去。
 *
 * 所以这一份测的就是那份交接：执行器**收到了什么**、以及它做完之后账本变成什么样。
 */

/** 假装自己是武器系统：把每次发射的上下文记下来，按有没有弹药决定成不成立。 */
const shots = [];
// 真武器系统在服务端启动路径上已经把 `shoot` 认领走了；这一份测的是交接本身，
// 所以先把它请下来，换上一个只记录上下文的替身。
unregisterShootAction();
registerItemUseAction('shoot', (context) => {
  shots.push({
    itemType: context.use.itemType,
    chargeRatio: context.chargeRatio,
    source: context.source,
    slot: context.slot,
    ammoBefore: context.ammo ? { ...context.ammo } : undefined,
  });
  // 没有弹药就打不出去：这一条判断归武器系统，物品系统不替它决定。
  return context.consumeAmmo(1) === 1;
});

function createClock(startAt = 1_000_000) {
  let current = startAt;
  return {
    now: () => current,
    advance(seconds) { current += seconds * 1000; },
  };
}

async function createScene(clock) {
  const catalog = await SceneCatalog.load();
  const scene = new ServerScene(catalog.require('grassland'), { now: clock.now });
  scene.addPlayer({ id: 'p1', name: '弹弓测试员', slot: 0 });
  const player = scene.players.get('p1');
  return { scene, player, inventory: player.getComponent(INVENTORY_COMPONENT) };
}

let sequence = 0;
const send = (scene, command) => scene.applyInventoryCommand('p1', {
  sequence: (sequence += 1),
  command,
});

test('装填是一次转移：石头从来源那一格搬进弹弓的弹药位', async () => {
  const clock = createClock();
  const { scene, inventory } = await createScene(clock);
  inventory.add('slingshot', 1);
  inventory.add('stone', 7);

  const slingshot = { kind: 'backpack', itemType: 'slingshot' };
  send(scene, { kind: 'ammo:load', slot: slingshot, source: { kind: 'backpack', itemType: 'stone' } });

  // 一次拖拽尽量装满：装到容量为止（5 发），剩下的留在来源那一摞上。
  assert.deepEqual(inventory.ammoAt(slingshot), { itemType: 'stone', quantity: 5 });
  assert.equal(inventory.quantityOf('stone'), 2);

  // 装满了就装不进去了，来源那一摞一颗都不该少。
  send(scene, { kind: 'ammo:load', slot: slingshot, source: { kind: 'backpack', itemType: 'stone' } });
  assert.equal(inventory.quantityOf('stone'), 2);
});

test('弹弓只吃它收的那一种：木头拖上去什么都不发生', async () => {
  const clock = createClock();
  const { scene, inventory } = await createScene(clock);
  inventory.add('slingshot', 1);
  inventory.add('wood', 3);

  const slingshot = { kind: 'backpack', itemType: 'slingshot' };
  send(scene, { kind: 'ammo:load', slot: slingshot, source: { kind: 'backpack', itemType: 'wood' } });
  assert.equal(inventory.ammoAt(slingshot), undefined);
  assert.equal(inventory.quantityOf('wood'), 3, '装不进去就一根都不该扣');
});

test('弹药跟着那一格走：装配到物品栏、收回背包，装着的石头都在', async () => {
  const clock = createClock();
  const { scene, inventory } = await createScene(clock);
  inventory.add('slingshot', 1);
  inventory.add('stone', 3);
  send(scene, {
    kind: 'ammo:load',
    slot: { kind: 'backpack', itemType: 'slingshot' },
    source: { kind: 'backpack', itemType: 'stone' },
  });

  send(scene, { kind: 'assign', slotIndex: 0, itemType: 'slingshot' });
  assert.deepEqual(inventory.hotbar[0].ammo, { itemType: 'stone', quantity: 3 });
  assert.equal(inventory.quantityOf('slingshot'), 0, '装配是一次转移，包里不该还有一把');

  send(scene, { kind: 'hotbar:stow', slotIndex: 0 });
  assert.deepEqual(
    inventory.ammoAt({ kind: 'backpack', itemType: 'slingshot' }),
    { itemType: 'stone', quantity: 3 },
    '收回背包也带着弹药',
  );
});

test('卸下弹药按拾取的落点回身上：先手上，再物品栏，最后背包', async () => {
  const clock = createClock();
  const { scene, inventory } = await createScene(clock);
  inventory.add('slingshot', 1);
  inventory.add('stone', 4);
  const slingshot = { kind: 'backpack', itemType: 'slingshot' };
  send(scene, { kind: 'ammo:load', slot: slingshot, source: { kind: 'backpack', itemType: 'stone' } });
  assert.equal(inventory.quantityOf('stone'), 0, '四颗全装进去了');

  send(scene, { kind: 'ammo:unload', slot: slingshot });
  assert.equal(inventory.ammoAt(slingshot), undefined);
  assert.equal(inventory.totalQuantityOf('stone'), 4);
  assert.equal(inventory.hotbar[0]?.itemType, 'stone', '空手时卸下的第一去处是手上那一格');
});

test('蓄力在松手那一刻结算，蓄了几成由服务端记的时刻算', async () => {
  const clock = createClock();
  const { scene, inventory } = await createScene(clock);
  shots.length = 0;
  inventory.add('slingshot', 1);
  inventory.add('stone', 2);
  send(scene, {
    kind: 'ammo:load',
    slot: { kind: 'backpack', itemType: 'slingshot' },
    source: { kind: 'backpack', itemType: 'stone' },
  });
  send(scene, { kind: 'assign', slotIndex: 0, itemType: 'slingshot' });
  send(scene, { kind: 'select', slotIndex: 0 });

  send(scene, { kind: 'use:begin' });
  // 弹弓 holdSeconds 是 0.9 秒：圈满也不自己打出去，停在满圈上等松手。
  clock.advance(2);
  scene.update();
  assert.deepEqual(shots, [], '蓄力拉满不是结算，弓不会自己射出去');

  send(scene, { kind: 'use:release' });
  assert.equal(shots.length, 1, '松手才是那一下');
  assert.equal(shots[0].chargeRatio, 1, '按满 0.9 秒就是十成');
  assert.deepEqual(shots[0].slot, { kind: 'hotbar', slotIndex: 0 });
  assert.deepEqual(shots[0].ammoBefore, { itemType: 'stone', quantity: 2 });
  assert.deepEqual(inventory.hotbar[0].ammo, { itemType: 'stone', quantity: 1 }, '打掉一发');
  assert.equal(inventory.hotbar[0].itemType, 'slingshot', '弹弓自己不消耗');
});

test('冷却中的那一下按不下去：圈都不该开始画', async () => {
  const clock = createClock();
  const { scene, player, inventory } = await createScene(clock);
  shots.length = 0;
  inventory.add('slingshot', 1);
  inventory.add('stone', 2);
  send(scene, {
    kind: 'ammo:load',
    slot: { kind: 'backpack', itemType: 'slingshot' },
    source: { kind: 'backpack', itemType: 'stone' },
  });
  send(scene, { kind: 'assign', slotIndex: 0, itemType: 'slingshot' });
  send(scene, { kind: 'select', slotIndex: 0 });

  send(scene, { kind: 'use:begin' });
  clock.advance(1);
  scene.update();
  send(scene, { kind: 'use:release' });
  assert.equal(shots.length, 1);
  // 冷却 0.5 秒，记在物品种类上，所以它跨得过「用完收回、重新授予」那一下。
  assert.ok(itemUseCooldownRemaining(player) > 0);

  assert.equal(send(scene, { kind: 'use:begin' }), false, '冷却中按不下去');
  assert.equal(player.itemUseStartedAt, undefined);
  send(scene, { kind: 'use:release' });
  assert.equal(shots.length, 1, '冷却中松手也不该打出第二发');

  // 冷却由 GAS 每 tick 自己走完；走完之后立刻又能用。
  clock.advance(0.6);
  scene.update();
  assert.equal(itemUseCooldownRemaining(player), 0);
  assert.equal(send(scene, { kind: 'use:begin' }), true);
  clock.advance(1);
  scene.update();
  send(scene, { kind: 'use:release' });
  assert.equal(shots.length, 2);
});

test('弹药空了这一下就不算数：扣不出弹药的那次发射由武器系统自己否决', async () => {
  const clock = createClock();
  const { scene, inventory } = await createScene(clock);
  shots.length = 0;
  inventory.add('slingshot', 1);
  send(scene, { kind: 'assign', slotIndex: 0, itemType: 'slingshot' });
  send(scene, { kind: 'select', slotIndex: 0 });

  send(scene, { kind: 'use:begin' });
  clock.advance(1);
  scene.update();
  send(scene, { kind: 'use:release' });
  assert.equal(shots.length, 1, '执行器照样被调用：空不空由它自己判断');
  assert.equal(shots[0].ammoBefore, undefined);
});

test('丢下一把装着石头的弹弓：石头回到身上，不跟着蒸发', async () => {
  const clock = createClock();
  const { scene, player, inventory } = await createScene(clock);
  inventory.add('slingshot', 1);
  inventory.add('stone', 3);
  send(scene, {
    kind: 'ammo:load',
    slot: { kind: 'backpack', itemType: 'slingshot' },
    source: { kind: 'backpack', itemType: 'stone' },
  });
  send(scene, { kind: 'assign', slotIndex: 0, itemType: 'slingshot' });
  send(scene, { kind: 'select', slotIndex: 0 });

  send(scene, { kind: 'drop:hotbar', slotIndex: 0 });
  assert.equal(inventory.totalQuantityOf('slingshot'), 0, '弹弓掉在地上了');
  assert.equal(inventory.totalQuantityOf('stone'), 3, '装着的石头回到身上');

  // 手持表现体也是一个 itemStack，它要等这一 tick 才真的消失，所以先跑一帧。
  scene.update();
  const heldId = player.getComponent(PICKUP_DROP_COMPONENT).heldActorId;
  const dropped = scene.actorWorld.actors().filter((actor) => (
    actor.getComponent(ITEM_STACK_COMPONENT)?.itemType === 'slingshot' && actor.id !== heldId
  ));
  assert.equal(dropped.length, 1, '地上正好一把');
});

test('F8 里点一件就给一个：落点和拾取一样，先手上', async () => {
  const clock = createClock();
  const { scene, player, inventory } = await createScene(clock);

  assert.equal(scene.giveDebugItem('p1', 'slingshot'), true);
  assert.equal(inventory.totalQuantityOf('slingshot'), 1);
  // 空手时第一去处是手上那一格，嘴上跟着出现模型——和捡起来完全一样。
  assert.equal(inventory.heldItemType, 'slingshot');
  assert.ok(player.getComponent(PICKUP_DROP_COMPONENT).heldActorId);

  // 目录里没有的 id 什么都不发生，不会凭空造出一件东西。
  assert.equal(scene.giveDebugItem('p1', 'not-a-real-item'), false);
  assert.equal(scene.giveDebugItem('nobody', 'stone'), false);
});
