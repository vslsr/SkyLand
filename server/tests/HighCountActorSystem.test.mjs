import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTOR_RESIDENCY_COMPONENT,
  COMBUSTIBLE_COMPONENT,
  DROP_MOTION_COMPONENT,
  INVENTORY_COMPONENT,
  ITEM_STACK_COMPONENT,
  TRANSFORM_COMPONENT,
} from '../../shared/actor/index.mjs';
import { itemCatalog } from '../../shared/items/index.mjs';
import { SceneCatalog } from '../scenes/SceneCatalog.mjs';
import { ServerScene } from '../scene/ServerScene.mjs';

async function createFixture() {
  const catalog = await SceneCatalog.load();
  let now = 100_000;
  const scene = new ServerScene(catalog.require('open-world'), { now: () => now });
  const advance = (ticks, milliseconds = 100) => {
    for (let index = 0; index < ticks; index += 1) {
      now += milliseconds;
      scene.update();
    }
  };
  return { scene, advance };
}

test('附近的休眠物品堆自动合并，捡起来直接到空着的手上', async () => {
  const { scene, advance } = await createFixture();
  scene.addPlayer({ id: 'player-1', name: '收集者', slot: 0 });
  const player = scene.players.get('player-1');
  scene.spawnItemStack('wood-pile', {
    quantity: 4,
    position: [player.x, 0.1, player.z],
  });
  scene.spawnItemStack('wood-pile', {
    quantity: 6,
    position: [player.x + 0.25, 0.1, player.z],
  });

  advance(16);
  const piles = scene.actorWorld.query(ITEM_STACK_COMPONENT);
  assert.equal(piles.length, 1);
  assert.equal(piles[0].requireComponent(ITEM_STACK_COMPONENT).quantity, 10);
  assert.equal(piles[0].requireComponent(ACTOR_RESIDENCY_COMPONENT).state, 'sleeping');

  assert.equal(scene.interactWithActor('player-1', { actorId: piles[0].id, sequence: 1 }), true);
  // 地上那一堆没了；世界里还剩的那个 itemStack 是嘴上的手持表现体。
  const remaining = scene.actorWorld.query(ITEM_STACK_COMPONENT);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].parent?.id, 'player-1');
  // 捡起来的东西先上手：空手时它落进物品栏第一格，并且当场就握着。
  const own = scene.createSnapshot('player-1').players[0];
  assert.deepEqual(own.hotbar.slots[0], { itemType: 'wood', quantity: 10 });
  assert.equal(own.hotbar.activeIndex, 0);
  assert.deepEqual(own.inventory, [], '物品栏装得下就轮不到背包');
});

test('物品栏和背包都满了之后，掉落堆留在世界里而不是被吞掉', async () => {
  const { scene, advance } = await createFixture();
  scene.addPlayer({ id: 'player-1', name: '收集者', slot: 0 });
  const player = scene.players.get('player-1');
  const inventory = player.requireComponent(INVENTORY_COMPONENT);

  // 一格堆到上限才会开下一格，所以这样正好把所有货位占满。
  const stackLimit = itemCatalog.require('stone').stackLimit;
  inventory.add('stone', stackLimit * inventory.slotCapacity);
  assert.equal(inventory.isFull, true);
  assert.equal(inventory.slots.length, inventory.slotCapacity);
  // 物品栏是拾取的第一去处，所以它也得占满，才轮得到「一个都收不下」。
  for (let index = 0; index < inventory.hotbarCapacity; index += 1) {
    inventory.hotbar[index] = { itemType: 'stone', quantity: stackLimit };
  }

  scene.spawnItemStack('wood-pile', {
    quantity: 3,
    position: [player.x, 0.1, player.z],
  });
  advance(16);
  const pile = scene.actorWorld.query(ITEM_STACK_COMPONENT)[0];
  assert.ok(pile, '木头应该还在世界里');

  assert.equal(
    scene.interactWithActor('player-1', { actorId: pile.id, sequence: 1 }),
    false,
    '拿不下就不该判定交互成功',
  );
  assert.equal(pile.requireComponent(ITEM_STACK_COMPONENT).quantity, 3, '数量一个都不该少');
  assert.equal(inventory.totalQuantityOf('wood'), 0);

  const snapshot = scene.createSnapshot('player-1').players[0];
  assert.equal(snapshot.inventory.length, inventory.slotCapacity);
  assert.deepEqual(snapshot.inventory[0], { itemType: 'stone', quantity: stackLimit });
  assert.equal(snapshot.inventoryRevision, inventory.revision);
});

test('木头受重力落下并滚动减速，停稳后进入 sleeping 且不再逐 tick 移动', async () => {
  const { scene, advance } = await createFixture();
  scene.addPlayer({ id: 'player-1', name: '观察者', slot: 0 });
  const player = scene.players.get('player-1');
  const x = player.x + 3;
  const z = player.z + 2;
  const groundY = scene.actorWorld.context.groundHeightAt?.(x, z) ?? 0;
  const log = scene.spawnItemStack('wood-pile', {
    quantity: 1,
    position: [x, groundY + 2, z],
    velocity: [0.9, 0.3, 0.35],
    yaw: 0.4,
  });
  const transform = log.requireComponent(TRANSFORM_COMPONENT);
  const start = { x: transform.x, y: transform.y, z: transform.z };

  advance(1);
  const motion = log.requireComponent(DROP_MOTION_COMPONENT);
  assert.ok(transform.y < start.y, '重力应让木头开始下落');
  assert.ok(Math.hypot(transform.x - start.x, transform.z - start.z) > 0, '水平速度应产生滚动位移');
  assert.equal(motion.radius, 0.12);
  assert.equal(log.requireComponent(ACTOR_RESIDENCY_COMPONENT).state, 'active');

  advance(100, 50);
  assert.equal(log.requireComponent(ACTOR_RESIDENCY_COMPONENT).state, 'sleeping');
  assert.equal(motion.velocityX, 0);
  assert.equal(motion.velocityY, 0);
  assert.equal(motion.velocityZ, 0);
  const settled = { x: transform.x, y: transform.y, z: transform.z };
  advance(20, 50);
  assert.deepEqual(
    { x: transform.x, y: transform.y, z: transform.z },
    settled,
    'sleeping Actor 不再进入物理积分',
  );
});

test('远离玩家的休眠 Actor 变成 chunk dormant record，玩家返回时恢复同一身份', async () => {
  const { scene, advance } = await createFixture();
  scene.addPlayer({ id: 'player-1', name: '离开者', slot: 0 });
  const player = scene.players.get('player-1');
  const pile = scene.spawnItemStack('wood-pile', {
    quantity: 3,
    position: [player.x, 0, player.z],
  });
  advance(16);
  scene.removePlayer('player-1');
  advance(40);

  assert.equal(scene.actorWorld.getActor(pile.id), undefined);
  assert.equal(scene.actorWorld.context.highCountActors.dormantCount, 1);

  scene.addPlayer({ id: 'player-2', name: '返回者', slot: 0 });
  advance(1);
  const restored = scene.actorWorld.getActor(pile.id);
  assert.ok(restored);
  assert.equal(restored.requireComponent(ITEM_STACK_COMPONENT).quantity, 3);
  assert.equal(scene.actorWorld.context.highCountActors.dormantCount, 0);
});

test('同 tick 合并并 dormant 时不会把已吞并的空 Actor 写成第二条记录', async () => {
  const { scene, advance } = await createFixture();
  scene.spawnItemStack('wood-pile', { quantity: 4, position: [0, 0, 0] });
  scene.spawnItemStack('wood-pile', { quantity: 6, position: [0.2, 0, 0] });
  advance(50);
  assert.equal(scene.actorWorld.query(ITEM_STACK_COMPONENT).length, 0);
  assert.equal(scene.actorWorld.context.highCountActors.dormantCount, 1);

  scene.addPlayer({ id: 'player-1', name: '检查者', slot: 0 });
  advance(1);
  const restored = scene.actorWorld.query(ITEM_STACK_COMPONENT);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].requireComponent(ITEM_STACK_COMPONENT).quantity, 10);
});

test('AOI 快照只向附近玩家复制物品堆，燃烧堆不会进入 dormant', async () => {
  const { scene, advance } = await createFixture();
  scene.addPlayer({ id: 'near-player', name: '近处', slot: 0 });
  scene.addPlayer({ id: 'far-player', name: '远处', slot: 1 });
  const near = scene.players.get('near-player');
  scene.players.get('far-player').setPosition(160, 160);
  const pile = scene.spawnItemStack('wood-pile', {
    quantity: 2,
    position: [near.x, 0, near.z],
  });
  advance(16);

  assert.ok(scene.createSnapshot('near-player').actors.some((actor) => actor.id === pile.id));
  assert.ok(!scene.createSnapshot('far-player').actors.some((actor) => actor.id === pile.id));

  pile.requireComponent(COMBUSTIBLE_COMPONENT).burning = true;
  scene.removePlayer('near-player');
  scene.removePlayer('far-player');
  advance(40);
  assert.ok(scene.actorWorld.getActor(pile.id));
  assert.equal(pile.requireComponent(ACTOR_RESIDENCY_COMPONENT).state, 'active');
  assert.equal(scene.actorWorld.context.highCountActors.dormantCount, 0);
});
import './initRapier.mjs';
