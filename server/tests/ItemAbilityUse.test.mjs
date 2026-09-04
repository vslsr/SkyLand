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

test('长按投掷：倒计时走完那一刻激活，松手与否都一样', async () => {
  const clock = createClock();
  const { scene, player, inventory } = await createScene(clock);
  inventory.add('mushroom', 2);
  send(scene, { kind: 'assign', slotIndex: 0, itemType: 'mushroom' });
  send(scene, { kind: 'select', slotIndex: 0 });

  send(scene, { kind: 'use:begin' });
  clock.advance(0.3);
  scene.update();
  assert.equal(inventory.hotbar[0].quantity, 2, '倒计时没走完，一个都不该扣');

  // 弹弹菇 holdSeconds 是 0.6 秒；走完就激活，玩家还按着也一样。
  clock.advance(0.4);
  scene.update();
  assert.equal(inventory.hotbar[0].quantity, 1, '倒计时走完那一刻扣掉一个');
  assert.equal(player.itemUseStartedAt, undefined, '这次按下结算完了');
  // 完成后收回，再按手上那件立刻重新挂上——不需要玩家重新装备一次。
  assert.equal(armedAbilityId(player), 'Ability.Item.mushroom');

  const thrown = scene.actorWorld.actors().filter((actor) => (
    actor.getComponent(ITEM_STACK_COMPONENT)?.itemType === 'mushroom'
    && actor.id !== player.getComponent(PICKUP_DROP_COMPONENT).heldActorId
  ));
  assert.equal(thrown.length, 1, '扔出去的是一个真正的掉落物，有自己的物理');
  assert.ok(thrown[0].getComponent(DROP_MOTION_COMPONENT), '飞出去的那个要有掉落物理');

  // 松手时倒计时早就走完了：不该再结算第二次。
  send(scene, { kind: 'use:release' });
  assert.equal(inventory.hotbar[0].quantity, 1);
});

test('投出最后一个之后手上就空了：那一格用空，模型跟着消失', async () => {
  const clock = createClock();
  const { scene, player, inventory } = await createScene(clock);
  inventory.add('mushroom', 1);
  send(scene, { kind: 'assign', slotIndex: 0, itemType: 'mushroom' });
  send(scene, { kind: 'select', slotIndex: 0 });
  assert.ok(player.getComponent(PICKUP_DROP_COMPONENT).heldActorId);

  send(scene, { kind: 'use:begin' });
  clock.advance(0.7);
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
  clock.advance(0.7);
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
  clock.advance(0.7);
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

test('点按的工具按一下就结算：按下开始、松手激活', async () => {
  const clock = createClock();
  const { scene, player, inventory } = await createScene(clock);
  inventory.add('harvest-hammer', 1);
  send(scene, { kind: 'assign', slotIndex: 0, itemType: 'harvest-hammer' });
  send(scene, { kind: 'select', slotIndex: 0 });
  assert.equal(armedAbilityId(player), 'Ability.Item.harvest-hammer');

  send(scene, { kind: 'use:begin' });
  clock.advance(0.05);
  // 面前没有可采集的目标，所以这次激活不产生效果——但按下的那次记录要被清掉，
  // 否则下一次按下会接着上一次的时刻算。
  send(scene, { kind: 'use:release' });
  assert.equal(player.itemUseStartedAt, undefined);
  // 工具在独立池里，敲一下不该少一把。
  assert.equal(inventory.hotbar[0].quantity, 1);
  assert.equal(armedAbilityId(player), 'Ability.Item.harvest-hammer', '用完立刻能再用一次');
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
