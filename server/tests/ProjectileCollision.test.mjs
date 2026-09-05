import assert from 'node:assert/strict';
import test from 'node:test';
import './initRapier.mjs';
import {
  HEALTH_COMPONENT,
  PATROL_PATH_COMPONENT,
  PROJECTILE_COMPONENT,
  TRANSFORM_COMPONENT,
} from '../../shared/actor/index.mjs';
import { COLLISION_LAYER_SOLID } from '../../shared/collision/index.mjs';
import {
  PROJECTILE_RADIUS,
  sweepProjectileArc,
  sweepProjectileTargets,
} from '../../shared/ballistics/index.mjs';
import { itemCatalog, resolveWeaponStrike } from '../../shared/items/index.mjs';
import { SceneCatalog } from '../scenes/SceneCatalog.mjs';
import { ServerScene } from '../scene/ServerScene.mjs';

/**
 * 弹药的碰撞检测（设计稿 `@w 木弓` 的 `A`）。
 *
 * 这一组测的是那条从「松手即判定」换到「箭飞到了才判定」的分界：射出去的是一个
 * 真的在世界里飞的 Actor，墙、地形、半路上的实体都能挡下它，而伤害发生在它停住
 * 的地方。老模型下面这几条**全都会失败**——那时箭穿墙，因为墙根本没有机会说话。
 */

const catalogPromise = SceneCatalog.load();
const BOW = itemCatalog.require('wood-bow').weapon;

async function createScene() {
  const catalog = await catalogPromise;
  let now = 2_000_000;
  const scene = new ServerScene(catalog.require('grassland'), { now: () => now });
  scene.addPlayer({ id: 'archer', name: '弓手', slot: 0 });
  const context = {
    scene,
    player: scene.players.get('archer'),
    advance(seconds) { now += seconds * 1000; scene.update(); },
    /** 跑到天上那支箭停住为止。 */
    flyOut(seconds = 1.2) {
      for (let step = 0; step < Math.ceil(seconds / 0.05); step += 1) context.advance(0.05);
      return scene.actorWorld.query(PROJECTILE_COMPONENT);
    },
  };
  scene.applyInventoryCommand('archer', {
    sequence: 1,
    command: { kind: 'assign', slotIndex: 0, itemType: 'wood-bow' },
  });
  scene.applyInventoryCommand('archer', { sequence: 2, command: { kind: 'select', slotIndex: 0 } });
  return context;
}

/** 拉满一箭射向 `target`，返回这一发有没有射出去。 */
function fireAt(context, target, sequence = 10) {
  const { scene, player } = context;
  scene.applyInventoryCommand('archer', { sequence, command: { kind: 'use:begin' } });
  context.advance(1.5);
  const transform = target.requireComponent(TRANSFORM_COMPONENT);
  player.setPosition(transform.x, transform.z - resolveWeaponStrike(BOW, 1).distance);
  player.yaw = 0;
  return scene.applyInventoryCommand('archer', {
    sequence: sequence + 2,
    command: { kind: 'use:release' },
  });
}

/**
 * 站着不动的靶子：飞行时间里走开的靶子测的是别的事。
 *
 * 摘掉巡逻 Component，而不是把速度调成 0——速度为 0 时巡逻 System 每 tick 仍然把
 * Actor 写回「出发点 + 当前路点」，挪过去的靶子下一 tick 就被拽回去。
 */
function freeze(target, position) {
  target.removeComponent(PATROL_PATH_COMPONENT);
  if (position) {
    const transform = target.requireComponent(TRANSFORM_COMPONENT);
    transform.setWorldTransform(position, transform.yaw);
  }
  return target;
}

test('墙挡下这一箭：箭停在墙上，墙后面的目标一点血都不掉', async () => {
  const context = await createScene();
  const { scene } = context;
  const walker = freeze(scene.actorWorld.getActor('legged-slime-walker-01'));
  const health = walker.requireComponent(HEALTH_COMPONENT);
  const target = walker.requireComponent(TRANSFORM_COMPONENT);

  assert.equal(fireAt(context, walker), true);
  // 松手之后再立墙：位置要按这一箭真正的弧来放，所以得先有那条弧。
  // 墙横在靶子身前 3 米，从地面一直立到 4 米——弧顶在那一段大约 2.4 米高。
  scene.physics.setActorCollider('test-wall', {
    shape: 'box',
    halfWidth: 6,
    halfLength: 0.25,
    minimumY: 0,
    maximumY: 4,
    x: target.x,
    y: 0,
    z: target.z - 3,
    yaw: 0,
    layers: COLLISION_LAYER_SOLID,
  });
  scene.physics.prepareQueries();

  const arrows = context.flyOut();
  assert.equal(arrows.length, 1, '箭该插在墙上留一会儿，而不是当场消失');
  const projectile = arrows[0].requireComponent(PROJECTILE_COMPONENT);
  assert.equal(projectile.stopped, true, '撞上墙就停下');
  const stoppedAt = arrows[0].requireComponent(TRANSFORM_COMPONENT);
  assert.ok(
    stoppedAt.z < target.z - 2.5,
    `箭该停在墙这一侧，实际停在 z=${stoppedAt.z.toFixed(2)}（墙在 ${(target.z - 3).toFixed(2)}）`,
  );
  assert.equal(health.current, 100, '墙后面的目标不该掉血');
});

test('半路上的实体先挨这一箭：它停在那儿，不再飞到名义落点', async () => {
  const context = await createScene();
  const { scene } = context;
  const far = freeze(scene.actorWorld.getActor('legged-slime-walker-01'));
  const near = scene.actorWorld.getActor('legged-slime-walker-02');
  const farTransform = far.requireComponent(TRANSFORM_COMPONENT);

  assert.equal(fireAt(context, far), true);
  // 把第二只挪到弧上、离射手 1.5 米处。那一段弧大约 1.1 米高，从这只史莱姆
  // 1.34 米高的身体里穿过去——它因此该在半路把这一箭接下来。
  freeze(near, [farTransform.x, 0, context.player.z + 1.5]);
  scene.actorWorld.context.refreshActorColliders?.();

  const arrows = context.flyOut();
  const projectile = arrows[0].requireComponent(PROJECTILE_COMPONENT);
  assert.equal(projectile.stopped, true);
  assert.ok(projectile.travel < 0.2, `该在半路停下，实际 travel=${projectile.travel.toFixed(3)}`);
  assert.ok(
    near.requireComponent(HEALTH_COMPONENT).current < 100,
    '挡在路上的那一只该挨这一箭',
  );
  assert.equal(
    far.requireComponent(HEALTH_COMPONENT).current,
    100,
    '被挡住之后，原本瞄的那一只一点血都不掉',
  );
});

test('射手自己的身体不挡自己的箭：出手点就在他身体里', async () => {
  const context = await createScene();
  const { scene, player } = context;
  const walker = freeze(scene.actorWorld.getActor('legged-slime-walker-01'));

  assert.equal(fireAt(context, walker), true);
  const arrows = context.flyOut();
  const projectile = arrows[0].requireComponent(PROJECTILE_COMPONENT);
  // 不排掉射手那具角色胶囊的话，第一段扫掠就撞在自己身上，travel 停在 0。
  assert.ok(projectile.travel > 0.5, `箭该飞出去，实际 travel=${projectile.travel.toFixed(3)}`);
  assert.equal(player.requireComponent(HEALTH_COMPONENT).current, 100);
});

test('插在那儿留一会儿就收走，天上不会攒下一堆箭', async () => {
  const context = await createScene();
  const { scene } = context;
  const walker = freeze(scene.actorWorld.getActor('legged-slime-walker-01'));

  assert.equal(fireAt(context, walker), true);
  assert.equal(context.flyOut().length, 1, '刚落地时还在');
  // 原型上的 lingerSeconds 是 1.6 秒。
  context.advance(2);
  assert.equal(scene.actorWorld.query(PROJECTILE_COMPONENT).length, 0, '到点该被收走');
});

test('沿弧扫掠：先碰到的那一个说了算，都没碰到就走完整条弧', () => {
  const arc = {
    originX: 0, originY: 1, originZ: 0, impactX: 0, impactY: 0, impactZ: 20, ratio: 1,
  };
  // 谁都不挡：走完整条弧，落在名义落点上。
  const clear = sweepProjectileArc(arc, {});
  assert.equal(clear.blocked, false);
  assert.equal(clear.travel, 1);
  assert.ok(Math.abs(clear.z - 20) < 1e-9);

  // 世界几何在半路：第八段（占整条弧 1/16）的一半处挡下。
  const wall = sweepProjectileArc(arc, {
    sweepWorld: (start, end) => (end[2] > 10 ? 0.5 : 1),
  });
  assert.equal(wall.blocked, true);
  assert.equal(wall.targetId, undefined, '撞墙不该报出一个目标');
  assert.ok(wall.travel > 0.5 && wall.travel < 0.6);

  // 同一段里实体更近：这一箭算打在它身上。
  const creature = sweepProjectileArc(arc, {
    sweepWorld: () => 0.9,
    sweepTargets: () => ({ fraction: 0.2, id: 'slime' }),
  });
  assert.equal(creature.targetId, 'slime');
  // 反过来，墙更近时不该报出目标——它挡在那只史莱姆前面。
  const blocked = sweepProjectileArc(arc, {
    sweepWorld: () => 0.2,
    sweepTargets: () => ({ fraction: 0.9, id: 'slime' }),
  });
  assert.equal(blocked.targetId, undefined);
});

test('实体窄相扫掠取最近的一个，射手自己排除在外', () => {
  const cylinder = {
    shape: 'cylinder',
    centerX: 0,
    centerZ: 0,
    halfWidth: 0.5,
    halfLength: 0.5,
    minimumY: 0,
    maximumY: 2,
    supportShape: 'cylinder',
    supportHalfWidth: 0.5,
    supportHalfLength: 0.5,
  };
  const candidates = [
    { id: 'far', collision: cylinder, transform: { x: 0, y: 0, z: 8, yaw: 0 } },
    { id: 'near', collision: cylinder, transform: { x: 0, y: 0, z: 4, yaw: 0 } },
    { id: 'archer', collision: cylinder, transform: { x: 0, y: 0, z: 0, yaw: 0 } },
  ];
  const hit = sweepProjectileTargets([0, 1, 0], [0, 1, 10], PROJECTILE_RADIUS, candidates, 'archer');
  assert.equal(hit?.id, 'near');
  // 只剩射手一个时什么都碰不到：出手点在他身体里，扫出来的必须是「没挡住」。
  assert.equal(
    sweepProjectileTargets([0, 1, 0], [0, 1, 10], PROJECTILE_RADIUS, [candidates[2]], 'archer'),
    undefined,
  );
});

test('箭插在被射中的那一只身上，跟着它走而不是留在半空', async () => {
  const context = await createScene();
  const { scene } = context;
  const walker = freeze(scene.actorWorld.getActor('legged-slime-walker-01'));
  const target = walker.requireComponent(TRANSFORM_COMPONENT);

  assert.equal(fireAt(context, walker), true);
  const arrows = context.flyOut();
  assert.ok(
    walker.requireComponent(HEALTH_COMPONENT).current < 100,
    '先确认这一箭真的打中了',
  );
  assert.equal(arrows[0].parent?.id, walker.id);

  const arrowZ = arrows[0].requireComponent(TRANSFORM_COMPONENT).z;
  target.setWorldTransform([target.x, target.y, target.z + 2], target.yaw);
  context.advance(0.05);
  assert.ok(
    Math.abs(arrows[0].requireComponent(TRANSFORM_COMPONENT).z - (arrowZ + 2)) < 1e-6,
    '靶子挪了两米，插在它身上的箭该挪同样的两米',
  );
});

test('打在墙上的那一支不挂给谁：它插在世界里，不跟着任何人走', async () => {
  const context = await createScene();
  const { scene } = context;
  const walker = freeze(scene.actorWorld.getActor('legged-slime-walker-01'));
  const target = walker.requireComponent(TRANSFORM_COMPONENT);

  assert.equal(fireAt(context, walker), true);
  scene.physics.setActorCollider('test-wall', {
    shape: 'box',
    halfWidth: 6,
    halfLength: 0.25,
    minimumY: 0,
    maximumY: 4,
    x: target.x,
    y: 0,
    z: target.z - 3,
    yaw: 0,
    layers: COLLISION_LAYER_SOLID,
  });
  scene.physics.prepareQueries();

  const arrows = context.flyOut();
  assert.equal(arrows[0].parent, undefined);
});
