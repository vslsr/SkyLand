import assert from 'node:assert/strict';
import test from 'node:test';

import { ServerScene } from '../scene/ServerScene.mjs';
import { SceneCatalog } from '../scenes/SceneCatalog.mjs';
import {
  DROP_MOTION_COMPONENT,
  INTERACTABLE_COMPONENT,
  INVENTORY_COMPONENT,
  ITEM_STACK_COMPONENT,
  ITEM_USE_ABILITY_SLOT,
  LIFETIME_COMPONENT,
  PICKUP_DROP_COMPONENT,
  SIMPLE_COLLISION_COMPONENT,
} from '../../shared/actor/index.mjs';
import { GAME_ABILITY_COMPONENT } from '../../shared/abilities/index.mjs';
import './initRapier.mjs';

/**
 * 使用一件物品的完整链路：授予能力 → 按配置激活 → 完成后收回。
 *
 * 这一层测的是**时刻**和**扣哪本账**：长按在倒计时走完那一刻激活（不是松手那一刻），
 * 手持物扣物品栏那一格，背包里点出来的扣背包，两条路都收回能力。
 */

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
  scene.addPlayer({ id: 'p1', name: '物品能力测试员', slot: 0 });
  const player = scene.players.get('p1');
  return { scene, player, inventory: player.getComponent(INVENTORY_COMPONENT) };
}

let sequence = 0;
const send = (scene, command) => scene.applyInventoryCommand('p1', {
  sequence: (sequence += 1),
  command,
});

/** 玩家身上现在挂着的那条物品能力的 id；没有就是 undefined。 */
function armedAbilityId(player) {
  const abilities = player.getComponent(GAME_ABILITY_COMPONENT);
  const handle = abilities.getAbilityHandle(ITEM_USE_ABILITY_SLOT);
  if (!handle) return undefined;
  return abilities.createSnapshot().abilities.find((entry) => entry.handle === handle)?.abilityId;
}

test('切到物品栏一格就授予那件东西的能力，切走就收回', async () => {
  const clock = createClock();
  const { scene, player, inventory } = await createScene(clock);
  inventory.add('mushroom', 2);
  send(scene, { kind: 'assign', slotIndex: 0, itemType: 'mushroom' });

  assert.equal(armedAbilityId(player), undefined, '还没切过去，手上是空的');
  send(scene, { kind: 'select', slotIndex: 0 });
  assert.equal(armedAbilityId(player), 'Ability.Item.mushroom');

  send(scene, { kind: 'select', slotIndex: 0 });
  assert.equal(inventory.heldItemType, undefined, '再按一次同一格是收手');
  assert.equal(armedAbilityId(player), undefined, '空手就不该挂着一条用不到的能力');
});

test('手持物品是纯表现体：没有碰撞、没有掉落物理、不会过期', async () => {
  const clock = createClock();
  const { scene, player, inventory } = await createScene(clock);
  inventory.add('mushroom', 1);
  send(scene, { kind: 'assign', slotIndex: 0, itemType: 'mushroom' });
  send(scene, { kind: 'select', slotIndex: 0 });

  const heldId = player.getComponent(PICKUP_DROP_COMPONENT).heldActorId;
  assert.ok(heldId, '切到那一格要在手上出现模型');
  const held = scene.actorWorld.getActor(heldId);
  assert.equal(held.parent?.id, 'p1', '坐标由 Actor 嵌套关系解算');
  assert.equal(held.getComponent(ITEM_STACK_COMPONENT).itemType, 'mushroom');
  assert.equal(held.getComponent(DROP_MOTION_COMPONENT), undefined, '手持物不掉落');
  assert.equal(held.getComponent(SIMPLE_COLLISION_COMPONENT), undefined, '手持物不挡人');
  assert.equal(held.getComponent(LIFETIME_COMPONENT), undefined, '手持物不会到点消失');
  assert.equal(held.getComponent(INTERACTABLE_COMPONENT), undefined, '手上那件不参与就近拾取');
  // 账一直在物品栏那一格上，手上那个不额外记一份。
  assert.equal(inventory.hotbar[0].quantity, 1);
});

test('长按吃下：倒计时走完那一刻咽下去，松手与否都一样', async () => {
  const clock = createClock();
  const { scene, player, inventory } = await createScene(clock);
  inventory.add('mushroom', 2);
  send(scene, { kind: 'assign', slotIndex: 0, itemType: 'mushroom' });
  send(scene, { kind: 'select', slotIndex: 0 });

  send(scene, { kind: 'use:begin' });
  clock.advance(0.5);
  scene.update();
  assert.equal(inventory.hotbar[0].quantity, 2, '还在嚼，一个都不该扣');

  // 蘑菇 holdSeconds 是 1 秒；走完就激活，玩家还按着也一样。
  clock.advance(0.6);
  scene.update();
  assert.equal(inventory.hotbar[0].quantity, 1, '倒计时走完那一刻扣掉一个');
  assert.equal(player.itemUseStartedAt, undefined, '这次按下结算完了');
  // 完成后收回，再按手上那件立刻重新挂上——不需要玩家重新装备一次。
  assert.equal(armedAbilityId(player), 'Ability.Item.mushroom');

  // 吃掉的东西不会变成世界里的一个掉落物：它进了嘴里，不是被扔了出去。
  const loose = scene.actorWorld.actors().filter((actor) => (
    actor.getComponent(ITEM_STACK_COMPONENT)?.itemType === 'mushroom'
    && actor.id !== player.getComponent(PICKUP_DROP_COMPONENT).heldActorId
  ));
  assert.deepEqual(loose, []);

  // 松手时倒计时早就走完了：不该再结算第二次。
  send(scene, { kind: 'use:release' });
  assert.equal(inventory.hotbar[0].quantity, 1);
});

test('吃掉最后一个之后手上就空了：那一格用空，模型跟着消失', async () => {
  const clock = createClock();
  const { scene, player, inventory } = await createScene(clock);
  inventory.add('mushroom', 1);
  send(scene, { kind: 'assign', slotIndex: 0, itemType: 'mushroom' });
  send(scene, { kind: 'select', slotIndex: 0 });
  assert.ok(player.getComponent(PICKUP_DROP_COMPONENT).heldActorId);

  send(scene, { kind: 'use:begin' });
  clock.advance(1.1);
  scene.update();

  assert.equal(inventory.hotbar[0], null, '用空的格子直接空出来');
  assert.equal(
    player.getComponent(PICKUP_DROP_COMPONENT).heldActorId,
    null,
    '手上那件是那一格的画面，格子空了它也该没了',
  );
  assert.equal(armedAbilityId(player), undefined, '空手就不该挂着一条用不到的能力');
});

test('长按没走完就松手是取消，什么都不发生', async () => {
  const clock = createClock();
  const { scene, player, inventory } = await createScene(clock);
  inventory.add('mushroom', 2);
  send(scene, { kind: 'assign', slotIndex: 0, itemType: 'mushroom' });
  send(scene, { kind: 'select', slotIndex: 0 });

  send(scene, { kind: 'use:begin' });
  clock.advance(0.3);
  send(scene, { kind: 'use:release' });
  clock.advance(2);
  scene.update();

  assert.equal(inventory.hotbar[0].quantity, 2, '取消掉的那次不扣货');
  assert.equal(player.itemUseStartedAt, undefined);
});

test('背包里点「使用」不经过手：扣的是背包那一摞，完成后收回能力', async () => {
  const clock = createClock();
  const { scene, player, inventory } = await createScene(clock);
  inventory.add('mushroom', 3);

  assert.equal(send(scene, { kind: 'use:arm', itemType: 'mushroom' }), true);
  assert.equal(armedAbilityId(player), 'Ability.Item.mushroom');
  assert.equal(
    player.getComponent(PICKUP_DROP_COMPONENT).heldActorId,
    null,
    '「使用」不再是「拿到手上」',
  );

  send(scene, { kind: 'use:begin' });
  clock.advance(1.1);
  scene.update();

  assert.equal(inventory.quantityOf('mushroom'), 2, '扣的是背包那一摞');
  assert.equal(inventory.hotbar[0], null, '物品栏一格都没被动过');
  // 完成后收回：手上空着，也没有别的东西armed，所以身上不该再挂着这条能力。
  assert.equal(armedAbilityId(player), undefined);
});

test('背包里点出来那条能力，换手就作废——不然扣的会是包里那件', async () => {
  const clock = createClock();
  const { scene, player, inventory } = await createScene(clock);
  inventory.add('mushroom', 3);
  send(scene, { kind: 'use:arm', itemType: 'mushroom' });
  send(scene, { kind: 'assign', slotIndex: 0, itemType: 'mushroom' });
  send(scene, { kind: 'select', slotIndex: 0 });

  // 换手之后挂着的必须是「手上这件」那条，扣的才是物品栏那一格。
  assert.equal(armedAbilityId(player), 'Ability.Item.mushroom');
  send(scene, { kind: 'use:begin' });
  clock.advance(1.1);
  scene.update();
  assert.equal(inventory.hotbar[0].quantity, 2, '扣的是物品栏那一格');
  assert.equal(inventory.quantityOf('mushroom'), 0, '背包那边一个都没动');
});

test('包里没有的东西点不出能力', async () => {
  const clock = createClock();
  const { scene, player } = await createScene(clock);
  assert.equal(send(scene, { kind: 'use:arm', itemType: 'mushroom' }), false);
  assert.equal(armedAbilityId(player), undefined);
});

test('没有用法的东西不挂能力：按键在它身上没有反应', async () => {
  const clock = createClock();
  const { scene, player, inventory } = await createScene(clock);
  inventory.add('wood', 3);
  send(scene, { kind: 'assign', slotIndex: 0, itemType: 'wood' });
  send(scene, { kind: 'select', slotIndex: 0 });

  // 木头拿得到手上（有模型），但目录里没登记 use——挂一条空能力只会让界面画出
  // 一个按下去什么都不发生的提示。
  assert.ok(player.getComponent(PICKUP_DROP_COMPONENT).heldActorId, '它仍然拿在手上');
  assert.equal(armedAbilityId(player), undefined);
  assert.equal(send(scene, { kind: 'use:begin' }), false);
  assert.equal(player.itemUseStartedAt, undefined);
  assert.equal(inventory.hotbar[0].quantity, 3);
});

test('长按走完之后玩家离开房间：手持表现体跟着连接消失，不留在世界里', async () => {
  const clock = createClock();
  const { scene, player, inventory } = await createScene(clock);
  inventory.add('mushroom', 1);
  send(scene, { kind: 'assign', slotIndex: 0, itemType: 'mushroom' });
  send(scene, { kind: 'select', slotIndex: 0 });
  const heldId = player.getComponent(PICKUP_DROP_COMPONENT).heldActorId;
  assert.ok(heldId);

  scene.removePlayer('p1');
  assert.equal(
    scene.actorWorld.getActor(heldId),
    undefined,
    '表现体只是把物品栏那一格画出来，货记在账上跟着玩家走',
  );
});
