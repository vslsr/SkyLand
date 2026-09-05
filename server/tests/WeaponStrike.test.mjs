import assert from 'node:assert/strict';
import test from 'node:test';
import './initRapier.mjs';
import {
  ACTOR_BUILD_TAG,
  ACTOR_CREATURE_TAG,
  ACTOR_PLAYER_TAG,
  HEALTH_COMPONENT,
  INVENTORY_COMPONENT,
  TRANSFORM_COMPONENT,
  resolveActorTags,
} from '../../shared/actor/index.mjs';
import {
  itemCatalog,
  resolveItemUse,
  resolveWeaponStrike,
  weaponDamage,
  weaponImpactPoint,
} from '../../shared/items/index.mjs';
import { SceneCatalog } from '../scenes/SceneCatalog.mjs';
import { ServerScene } from '../scene/ServerScene.mjs';

const catalogPromise = SceneCatalog.load();
const BOW = itemCatalog.require('wood-bow').weapon;

async function createScene() {
  const catalog = await catalogPromise;
  let now = 2_000_000;
  const scene = new ServerScene(catalog.require('grassland'), { now: () => now });
  scene.addPlayer({ id: 'archer', name: '弓手', slot: 0 });
  return {
    scene,
    player: scene.players.get('archer'),
    get now() { return now; },
    advance(seconds) {
      now += seconds * 1000;
      scene.update();
    },
  };
}

/** 把出生背包里那把弓装到物品栏第一格并选中它。 */
function equipBow(scene) {
  scene.applyInventoryCommand('archer', {
    sequence: 1,
    command: { kind: 'assign', slotIndex: 0, itemType: 'wood-bow' },
  });
  return scene.applyInventoryCommand('archer', {
    sequence: 2,
    command: { kind: 'select', slotIndex: 0 },
  });
}

/**
 * 站到「这一箭正好落在目标身上」的位置。
 *
 * 巡逻史莱姆在蓄力那一秒里还在走，所以瞄准要在**松手前**做：判定用的是松手那一
 * 刻的权威朝向与位置，测试也照这个时刻摆。
 */
function aimAt(player, target, heldSeconds) {
  const ratio = Math.min(1, heldSeconds / resolveItemUse('wood-bow').holdSeconds);
  // 空放没有落点，那一箭本来就不出去；站在最短射程处即可。
  const distance = resolveWeaponStrike(BOW, ratio)?.distance ?? BOW.range.minimum;
  const transform = target.requireComponent(TRANSFORM_COMPONENT);
  player.setPosition(transform.x, transform.z - distance);
  player.yaw = 0;
}

/** 按住 `heldSeconds` 秒再松手。返回这一次使用有没有做成事。 */
function fire(context, heldSeconds, target) {
  const { scene } = context;
  const sequence = (fire.sequence = (fire.sequence ?? 0) + 1);
  // 序号只要单调递增；前两个号留给装配与选中。
  scene.applyInventoryCommand('archer', {
    sequence: sequence * 4 + 2,
    command: { kind: 'use:begin' },
  });
  context.advance(heldSeconds);
  if (target) aimAt(context.player, target, heldSeconds);
  return scene.applyInventoryCommand('archer', {
    sequence: sequence * 4 + 4,
    command: { kind: 'use:release' },
  });
}

test('蓄力换算：低于阈值是空放，拉满时射程与伤害都到顶', () => {
  assert.equal(resolveWeaponStrike(BOW, 0.1), undefined, '空放不发射');
  // 射程与倍率按**原始比例**在两端之间线性取值：`range.minimum` 是比例为 0 那一端，
  // 空放阈值只决定「这一箭发不发得出去」，不重新拉伸这条线。
  const light = resolveWeaponStrike(BOW, BOW.charge.minimumRatio);
  const span = BOW.range.maximum - BOW.range.minimum;
  assert.ok(Math.abs(light.distance - (BOW.range.minimum + span * BOW.charge.minimumRatio)) < 1e-9);
  assert.ok(light.damageScale > BOW.charge.damageScale.minimum);
  assert.equal(resolveWeaponStrike(BOW, 0)?.distance, undefined, '完全没拉就没有这一箭');
  const full = resolveWeaponStrike(BOW, 1);
  assert.equal(full.distance, BOW.range.maximum);
  assert.equal(full.damageScale, BOW.charge.damageScale.maximum);
  // 一半蓄力落在两端中间：换算是线性的，没有隐藏的曲线。
  const half = resolveWeaponStrike(BOW, 0.5);
  assert.ok(Math.abs(half.distance - (BOW.range.minimum + BOW.range.maximum) / 2) < 1e-9);
});

test('落点是朝向推出去的那一点，抛物线不参与判定', () => {
  const north = weaponImpactPoint(0, 0, 0, 10);
  assert.ok(Math.abs(north.x) < 1e-9);
  assert.ok(Math.abs(north.z - 10) < 1e-9);
  const east = weaponImpactPoint(2, -1, Math.PI / 2, 4);
  assert.ok(Math.abs(east.x - 6) < 1e-9);
  assert.ok(Math.abs(east.z + 1) < 1e-9);
});

test('标签倍率按目标改判：射建筑只有一成伤害', () => {
  const strike = resolveWeaponStrike(BOW, 1);
  assert.equal(weaponDamage(BOW, strike, [ACTOR_CREATURE_TAG]), 10);
  assert.equal(weaponDamage(BOW, strike, [ACTOR_PLAYER_TAG]), 10);
  assert.ok(Math.abs(weaponDamage(BOW, strike, [ACTOR_BUILD_TAG]) - 1) < 1e-9);
  // 父标签匹配得上子标签：倍率表不必把每一种墙都列一遍。
  assert.ok(Math.abs(weaponDamage(BOW, strike, ['Actor.Build.Wall']) - 1) < 1e-9);
});

test('标签由 Component 推导，不需要每份配置各写一遍', async () => {
  const { scene, player } = await createScene();
  const walker = scene.actorWorld.getActor('legged-slime-walker-01');
  assert.deepEqual(resolveActorTags(walker), [ACTOR_CREATURE_TAG]);
  assert.deepEqual(resolveActorTags(player), [ACTOR_PLAYER_TAG]);
});

test('拉满一箭打中面前的史莱姆，伤害按蓄力与标签结算', async () => {
  const context = await createScene();
  const { scene, player } = context;
  const walker = scene.actorWorld.getActor('legged-slime-walker-01');
  const transform = walker.requireComponent(TRANSFORM_COMPONENT);
  const health = walker.requireComponent(HEALTH_COMPONENT);

  // 木弓在出生背包里；装到物品栏上才拿在手上。
  assert.equal(equipBow(scene), true);
  assert.equal(player.getComponent(INVENTORY_COMPONENT).heldItemType, 'wood-bow');

  assert.equal(fire(context, 1.5, walker), true, '拉满松手应当射出去');
  // 5 × 2.0 = 10
  assert.equal(health.current, 90);
});

test('空放不发射，拉满之后的连发被 CD 挡住', async () => {
  const context = await createScene();
  const { scene, player } = context;
  const walker = scene.actorWorld.getActor('legged-slime-walker-01');
  const transform = walker.requireComponent(TRANSFORM_COMPONENT);
  const health = walker.requireComponent(HEALTH_COMPONENT);
  equipBow(scene);

  // 点一下就松：比例远低于 0.15，空放。
  assert.equal(fire(context, 0.05, walker), false, '空放不该算做成事');
  assert.equal(health.current, 100);
  // 冷却记在「按下去用了一次」上，不记在「打没打中」上：空放同样要等这 0.1 秒，
  // 否则空放就成了一个可以无限点的动作。
  context.advance(0.2);

  assert.equal(fire(context, 1.5, walker), true);
  assert.equal(health.current, 90);
  // 冷却 0.1 秒：紧接着的一箭被能力系统挡下，血量不动。
  assert.equal(fire(context, 0.01, walker), false);
  assert.equal(health.current, 90);
});

test('射空地不打到任何人，自己也不会被自己射中', async () => {
  const context = await createScene();
  const { scene, player } = context;
  const walker = scene.actorWorld.getActor('legged-slime-walker-01');
  const health = walker.requireComponent(HEALTH_COMPONENT);
  const playerHealth = player.requireComponent(HEALTH_COMPONENT);
  equipBow(scene);
  // 瞄准它，然后原地转身背对着射出去。
  aimAt(player, walker, 1.5);
  const away = () => { player.yaw = Math.PI; };

  scene.applyInventoryCommand('archer', { sequence: 100, command: { kind: 'use:begin' } });
  context.advance(1.5);
  away();
  assert.equal(
    scene.applyInventoryCommand('archer', { sequence: 102, command: { kind: 'use:release' } }),
    true,
    '一箭确实射出去了',
  );
  assert.equal(health.current, 100, '朝反方向射不该打中它');
  assert.equal(playerHealth.current, 100, '射出去的箭打不到射它的人');
});

test('武器不消耗自己：射完手上那把弓还在', async () => {
  const context = await createScene();
  const { scene, player } = context;
  equipBow(scene);
  fire(context, 1.5);
  assert.equal(player.getComponent(INVENTORY_COMPONENT).heldItemType, 'wood-bow');
  assert.equal(resolveItemUse('wood-bow').mode, 'charge');
});

test('拉弓和射出去那一发都进快照：别人也看得见', async () => {
  const context = await createScene();
  const { scene, player } = context;
  const walker = scene.actorWorld.getActor('legged-slime-walker-01');
  equipBow(scene);
  const viewerSnapshot = () => scene.createSnapshot('watcher')
    .players.find((entry) => entry.id === 'archer');

  // 没按住的时候两条都不下发：快照里不带一条恒为空的字段。
  assert.equal(viewerSnapshot().charge, undefined);
  assert.equal(viewerSnapshot().weaponShot, undefined);

  scene.applyInventoryCommand('archer', { sequence: 500, command: { kind: 'use:begin' } });
  const charging = viewerSnapshot().charge;
  // 带的是起点和总时长，不是算好的比例：两端跑同一个 holdRatio，接收方用自己的
  // 时钟推进，中间掉几帧也不会让弓卡在半路上。
  assert.equal(charging.startedAt, player.itemUseStartedAt);
  assert.ok(charging.holdSeconds > 0);

  aimAt(player, walker, 1.5);
  context.advance(1.5);
  aimAt(player, walker, 1.5);
  scene.applyInventoryCommand('archer', { sequence: 504, command: { kind: 'use:release' } });

  assert.equal(viewerSnapshot().charge, undefined, '松手之后就不再蓄了');
  const shot = viewerSnapshot().weaponShot;
  assert.equal(shot.revision, 1);
  assert.equal(shot.ratio, 1, '拉满');
  // 带的是**落点**：判定用的就是这一点，所有人因此画的是同一条弧。
  const transform = walker.requireComponent(TRANSFORM_COMPONENT);
  assert.ok(Math.abs(shot.impactZ - transform.z) < 1.5);
  assert.ok(Math.abs(shot.x - player.x) < 1e-6);

  // 留着不撤：只在开火那一帧下发的话，那一帧丢了这支箭就永远不会出现。
  context.advance(1);
  assert.equal(viewerSnapshot().weaponShot.revision, 1);
});
