import assert from 'node:assert/strict';
import test from 'node:test';
import './initRapier.mjs';
import {
  ACTOR_BUILD_TAG,
  ACTOR_CREATURE_TAG,
  ACTOR_PLAYER_TAG,
  HEALTH_COMPONENT,
  PICKUP_DROP_COMPONENT,
  INVENTORY_COMPONENT,
  PATROL_PATH_COMPONENT,
  PROJECTILE_COMPONENT,
  TRANSFORM_COMPONENT,
  resolveActorTags,
} from '../../shared/actor/index.mjs';
import {
  itemCatalog,
  resolveItemUse,
  resolveWeaponStrike,
  weaponDamage,
  weaponHitDirection,
  weaponHitImpulse,
  weaponImpactPoint,
  MINIMUM_HIT_IMPULSE,
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
 * 把巡逻史莱姆钉在原地，当一个靶子用。
 *
 * 箭现在要飞过去才结算（0.65 秒左右），走着的靶子在这段时间里会挪开——那正是
 * 这套改动想要的物理，但它让「这一箭该不该打中」变成一个和路线有关的问题。
 * 测判定的时候把它停住，测移动的时候再让它走。
 *
 * 摘掉整个 Component 而不是把速度调成 0：速度为 0 时巡逻 System 每 tick 仍然把
 * Actor 写回「出发点 + 当前路点」。
 */
function freeze(target) {
  target.removeComponent(PATROL_PATH_COMPONENT);
  return target;
}

/** 让世界跑到天上那支箭落地为止。返回还剩几支在飞（正常是 0）。 */
function flyOut(context, seconds = 1.2) {
  for (let step = 0; step < Math.ceil(seconds / 0.05); step += 1) context.advance(0.05);
  return context.scene.actorWorld.query(PROJECTILE_COMPONENT)
    .filter((arrow) => !arrow.requireComponent(PROJECTILE_COMPONENT).stopped).length;
}

/**
 * 站到「这一箭正好落在目标身上」的位置。
 *
 * 瞄准在**松手前**做：弧由松手那一刻的权威朝向与位置定下来，测试也照这个时刻摆。
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

test('拉满一箭打中面前的史莱姆，伤害在箭飞到的那一刻结算', async () => {
  const context = await createScene();
  const { scene, player } = context;
  const walker = freeze(scene.actorWorld.getActor('legged-slime-walker-01'));
  const health = walker.requireComponent(HEALTH_COMPONENT);

  // 木弓在出生背包里；装到物品栏上才拿在手上。
  assert.equal(equipBow(scene), true);
  assert.equal(player.getComponent(INVENTORY_COMPONENT).heldItemType, 'wood-bow');

  assert.equal(fire(context, 1.5, walker), true, '拉满松手应当射出去');
  // **松手那一刻还不掉血**：这一箭刚离弦，二十几米外的目标什么都没发生。判定跟着
  // 箭走，不再跟着按键走——墙、地形、半路上的人因此都有机会挡下它。
  assert.equal(health.current, 100, '箭还在飞，伤害不该已经结算');
  const flying = scene.actorWorld.query(PROJECTILE_COMPONENT);
  assert.equal(flying.length, 1, '松手应当生成一支真的在飞的箭');
  assert.equal(flying[0].requireComponent(PROJECTILE_COMPONENT).ownerActorId, 'archer');

  assert.equal(flyOut(context), 0, '这一箭应当在一秒出头之内落地');
  // 5 × 2.0 = 10
  assert.equal(health.current, 90);
});

test('空放不发射，拉满之后的连发被 CD 挡住', async () => {
  const context = await createScene();
  const { scene } = context;
  const walker = freeze(scene.actorWorld.getActor('legged-slime-walker-01'));
  const health = walker.requireComponent(HEALTH_COMPONENT);
  equipBow(scene);

  // 点一下就松：比例远低于 0.15，空放。
  assert.equal(fire(context, 0.05, walker), false, '空放不该算做成事');
  assert.equal(scene.actorWorld.query(PROJECTILE_COMPONENT).length, 0, '空放不该有箭出去');
  assert.equal(health.current, 100);
  // 冷却记在「按下去用了一次」上，不记在「打没打中」上：空放同样要等这 0.1 秒，
  // 否则空放就成了一个可以无限点的动作。
  context.advance(0.2);

  assert.equal(fire(context, 1.5, walker), true);
  assert.equal(flyOut(context), 0);
  assert.equal(health.current, 90);
  // 冷却 0.1 秒：紧接着的一箭被能力系统挡下，血量不动。
  assert.equal(fire(context, 0.01, walker), false);
  assert.equal(flyOut(context), 0);
  assert.equal(health.current, 90);
});

test('射空地不打到任何人，自己也不会被自己射中', async () => {
  const context = await createScene();
  const { scene, player } = context;
  const walker = freeze(scene.actorWorld.getActor('legged-slime-walker-01'));
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
  flyOut(context);
  assert.equal(health.current, 100, '朝反方向射不该打中它');
  assert.equal(playerHealth.current, 100, '射出去的箭打不到射它的人');
});

test('武器不消耗自己：射完手上那把弓还在', async () => {
  const context = await createScene();
  const { scene, player } = context;
  equipBow(scene);
  fire(context, 1.5);
  flyOut(context);
  assert.equal(player.getComponent(INVENTORY_COMPONENT).heldItemType, 'wood-bow');
  assert.equal(resolveItemUse('wood-bow').mode, 'charge');
});

test('拉弓和撒手那一下都进快照：别人也看得见', async () => {
  const context = await createScene();
  const { scene, player } = context;
  const walker = freeze(scene.actorWorld.getActor('legged-slime-walker-01'));
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
  // 只带一个计数：飞出去那支箭是复制过来的 Actor，落在哪儿由它自己说了算，
  // 接收方拿这条抖一下别人那把弓的弦而已。
  assert.deepEqual(viewerSnapshot().weaponShot, { revision: 1 });

  // 留着不撤：只在开火那一帧下发的话，那一帧丢了别人的弓就永远不会抖那一下。
  context.advance(1);
  assert.equal(viewerSnapshot().weaponShot.revision, 1);
  assert.equal(flyOut(context), 0, '把这一箭放完，免得拖到下一条用例');
});

test('来袭方向是「射手 → 这一个目标」，两人重合时退回权威 yaw', () => {
  // 正北打过去：+Z。方向是**弹药飞进去的方向**，也就是蒙皮该被压凹的方向。
  const north = weaponHitDirection(0, 0, 0, 6, 0);
  assert.ok(Math.abs(north.x) < 1e-9 && Math.abs(north.z - 1) < 1e-9);
  // 侧面那一只按它自己的方位算，不是按 yaw：一次落点里可能站着好几个东西。
  const flank = weaponHitDirection(0, 0, 3, 4, 0);
  assert.ok(Math.abs(flank.x - 0.6) < 1e-9 && Math.abs(flank.z - 0.8) < 1e-9);
  assert.ok(Math.abs(Math.hypot(flank.x, flank.z) - 1) < 1e-9, '必须是单位向量');
  // 目标正好站在脚下：零向量没有方向可言，退回朝向。
  const overlapped = weaponHitDirection(2, -1, 2, -1, Math.PI / 2);
  assert.ok(Math.abs(overlapped.x - 1) < 1e-9 && Math.abs(overlapped.z) < 1e-9);
});

test('冲量只看蓄力，不看伤害倍率：射墙和射史莱姆凹得一样深', () => {
  assert.equal(weaponHitImpulse(undefined), 0, '没射出去就没有这一下');
  assert.equal(weaponHitImpulse(resolveWeaponStrike(BOW, 1)), 1);
  const light = weaponHitImpulse(resolveWeaponStrike(BOW, BOW.charge.minimumRatio));
  assert.ok(light >= MINIMUM_HIT_IMPULSE, `最轻的一发也要看得见，实际 ${light}`);
  assert.ok(light < 1);
  // 标签倍率把伤害压到一成，冲量不跟着变——扎进去多深是箭的事。
  const strike = resolveWeaponStrike(BOW, 1);
  assert.ok(Math.abs(weaponDamage(BOW, strike, [ACTOR_BUILD_TAG]) - 1) < 1e-9);
  assert.equal(weaponHitImpulse(strike), 1);
});

test('中箭把来袭方向记进复制面：方向、冲量与事件计数一起过网', async () => {
  const context = await createScene();
  const { scene } = context;
  const walker = freeze(scene.actorWorld.getActor('legged-slime-walker-01'));
  const health = walker.requireComponent(HEALTH_COMPONENT);
  equipBow(scene);

  assert.equal(health.snapshot().lastHitImpulse, undefined, '没挨过打就不占这几个字段');

  // aimAt 把弓手摆在目标正南方 `distance` 米处，yaw = 0：箭朝 +Z 飞进去。
  // 方向记在**箭飞到的那一刻**，所以要等它飞完这一段。
  assert.equal(fire(context, 1.5, walker), true);
  assert.equal(health.snapshot().lastHitImpulse, undefined, '箭还在飞，这一下还没发生');
  assert.equal(flyOut(context), 0);
  const hit = health.snapshot();
  assert.equal(hit.lastHitImpulse, 1, '拉满就是满冲量');
  assert.ok(hit.lastHitZ > 0.9, `水平方向该朝 +Z，实际 ${hit.lastHitZ}`);
  assert.ok(Math.abs(hit.lastHitX) < 1e-6);
  // **斜着扎下来**：竖直那一份取的是箭停住那一点的弧切线。拉满一箭飞 22 米，
  // 落下来大约二十来度——平着飞进去的箭是这条链路上原来那个洞。
  const pitchDegrees = Math.asin(-hit.lastHitY) * 180 / Math.PI;
  assert.ok(
    pitchDegrees > 10 && pitchDegrees < 40,
    `该以十几到几十度扎下来，实际 ${pitchDegrees.toFixed(1)}°`,
  );
  assert.ok(
    Math.abs(Math.hypot(hit.lastHitX, hit.lastHitY, hit.lastHitZ) - 1) < 1e-3,
    '过网的是单位向量',
  );
  assert.ok(hit.lastDelta < 0 && hit.eventRevision > 0, '飘字和这一下读的是同一次事件');

  // 治疗也是一次事件，但它没有方向：不清零的话，客户端会拿上一箭的轴再砸一次。
  scene.applyHealthChange(walker.id, 5);
  const healed = health.snapshot();
  assert.equal(healed.lastHitImpulse, undefined);
  assert.equal(healed.lastHitZ, undefined);
  assert.ok(healed.eventRevision > hit.eventRevision, '治疗照样是一次事件');
});

test('没有方向的伤害照常结算，只是没有那一下凹陷', async () => {
  const context = await createScene();
  const { scene } = context;
  const walker = freeze(scene.actorWorld.getActor('legged-slime-walker-01'));
  const health = walker.requireComponent(HEALTH_COMPONENT);
  // 调试指令、火、跌落都走同一个入口，只是不带 impact。
  scene.applyHealthChange(walker.id, -10);
  assert.equal(health.current, 90);
  assert.equal(health.lastHitImpulse, 0);
  assert.equal(health.snapshot().lastHitX, undefined);
});

test('一箭把叼着东西的人射死，不会在 tick 里炸掉房间', async () => {
  // 这一条守的是时机，不是伤害。伤害现在落在**箭真的到了**那一刻，也就是弹药
  // System 的 tick 中途；那时 `ActorWorld` 正在迭代，`addActor` 会排队。死亡的
  // 连带后果里要重挂手持表现体（「先建出来、再挂上去」两步），中间夹一次排队
  // 的话第二步就找不到第一步建的那个 Actor，房间进程直接抛「不存在 Actor」倒下。
  const context = await createScene();
  const { scene } = context;
  equipBow(scene);

  scene.addPlayer({ id: 'victim', name: '靶子', slot: 1 });
  const victim = scene.players.get('victim');
  // 靶子手上也拿着一件东西：死亡那一下要对齐的就是它。
  scene.applyInventoryCommand('victim', {
    sequence: 1,
    command: { kind: 'assign', slotIndex: 0, itemType: 'wood-bow' },
  });
  scene.applyInventoryCommand('victim', {
    sequence: 2,
    command: { kind: 'select', slotIndex: 0 },
  });
  scene.update();
  const held = victim.requireComponent(PICKUP_DROP_COMPONENT);
  const heldBefore = held.heldActorId;
  assert.ok(heldBefore, '靶子手上确实叼着一件东西');

  // 一箭就得打死，死亡才会落在飞行结算那一刻。
  // 权威血量在 GAS 上，`health.current` 只是复制面的镜像——直接写它不算数，
  // 得走同一个入口把人先打到只剩一口气。
  const health = victim.requireComponent(HEALTH_COMPONENT);
  scene.applyHealthChange('victim', -(health.maximum - 1));
  assert.equal(health.current, 1, '靶子只剩一口气');
  victim.setPosition(0, 20);
  scene.update();
  fire(context, 1.2, victim);
  assert.equal(flyOut(context), 0, '箭飞完了');

  assert.equal(health.dead, true, '这一箭把人射死了');
  // 走到这里就说明没抛：那次对齐排到了本轮 System 之后，而不是在迭代中途
  // 「建一个排队的 Actor、下一行就去挂它」。
  assert.notEqual(held.heldActorId, heldBefore, '死亡的连带对齐真的做了');
  const rebuilt = scene.actorWorld.getActor(held.heldActorId);
  assert.ok(rebuilt, '重挂的那件手持表现体确实在世界里');
  assert.equal(rebuilt.parent?.id, 'victim', '而且挂在了它的主人身上');
});
