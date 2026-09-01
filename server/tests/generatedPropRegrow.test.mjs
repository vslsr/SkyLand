import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTOR_RESIDENCY_COMPONENT,
  DROP_MOTION_COMPONENT,
  GENERATED_PROP_COMPONENT,
  ITEM_STACK_COMPONENT,
  TRANSFORM_COMPONENT,
} from '../../shared/actor/index.mjs';
import {
  fruitDropWorldPosition,
  selectFruitDropAnchors,
} from '../../shared/world/fruitDrop.mjs';
import { CHUNK_SIZE, PROP_KIND } from '../../shared/world/worldConfig.mjs';
import { SceneCatalog } from '../scenes/SceneCatalog.mjs';
import { ServerScene } from '../scene/ServerScene.mjs';

const SEED = 0x5c1a2d0b;
const START_MS = 1_000_000_000;

/** 果林场景 + 一个可以手动推进的时钟。 */
async function createOrchard() {
  const catalog = await SceneCatalog.load();
  const clock = { ms: START_MS };
  const scene = new ServerScene(catalog.require('orchard'), {
    worldSeed: SEED,
    now: () => clock.ms,
  });
  scene.addPlayer({ id: 'picker', name: '采果人', slot: 0 });
  return { scene, clock, player: scene.players.get('picker') };
}

function nearestFruitTree(scene, x, z) {
  return scene.actorWorld
    .query(GENERATED_PROP_COMPONENT, TRANSFORM_COMPONENT)
    .filter((actor) => actor.requireComponent(GENERATED_PROP_COMPONENT).kind === PROP_KIND.TREE)
    .reduce((nearest, candidate) => {
      if (!nearest) return candidate;
      const a = candidate.requireComponent(TRANSFORM_COMPONENT);
      const b = nearest.requireComponent(TRANSFORM_COMPONENT);
      return Math.hypot(a.x - x, a.z - z) < Math.hypot(b.x - x, b.z - z) ? candidate : nearest;
    }, undefined);
}

function moveTo(scene, x, z) {
  scene.players.get('picker').setPosition(x, z);
  scene.chunkColliders.ensureAround(x, z);
  scene.generatedProps.ensureAround(x, z);
}

function fruitStacks(scene) {
  return scene.actorWorld.query(ITEM_STACK_COMPONENT).filter((actor) => (
    actor.requireComponent(ITEM_STACK_COMPONENT).itemType === 'fruit'
  ));
}

test('摘果子不砍树：逐颗从可见枝头生成，树与静态碰撞一点没动', async () => {
  const { scene, player } = await createOrchard();
  const tree = nearestFruitTree(scene, player.x, player.z);
  const prop = tree.requireComponent(GENERATED_PROP_COMPONENT);
  const transform = tree.requireComponent(TRANSFORM_COMPONENT);
  assert.equal(prop.regrowable, true);
  assert.equal(prop.regrowSeconds, 120);
  moveTo(scene, transform.x + 0.5, transform.z);

  assert.equal(scene.interactWithActor('picker', { actorId: tree.id, sequence: 1 }), true);
  assert.equal(prop.removed, false, '果树不会被采没');
  assert.ok(scene.actorWorld.getActor(tree.id), 'Actor 还在');
  const mask = scene.chunkColliders.getSkipMask(prop.chunkX, prop.chunkZ);
  assert.equal(mask.low === 0 && mask.high === 0, true, '几何体与碰撞都不该被撤走');
  const drops = fruitStacks(scene);
  const anchors = selectFruitDropAnchors(prop.dropQuantity);
  assert.equal(drops.length, anchors.length);
  assert.equal(
    drops.reduce((total, actor) => total + actor.requireComponent(ITEM_STACK_COMPONENT).quantity, 0),
    prop.dropQuantity,
  );
  const expectedOrigins = anchors.map((anchor) => fruitDropWorldPosition(transform, prop.scale, anchor));
  for (let index = 0; index < drops.length; index += 1) {
    const dropTransform = drops[index].requireComponent(TRANSFORM_COMPONENT);
    assert.ok(Math.abs(dropTransform.x - expectedOrigins[index].x) < 1e-9);
    assert.ok(Math.abs(dropTransform.y - expectedOrigins[index].y) < 1e-9);
    assert.ok(Math.abs(dropTransform.z - expectedOrigins[index].z) < 1e-9);
    assert.equal(drops[index].requireComponent(ITEM_STACK_COMPONENT).quantity, 1);
  }
});

test('枝头果实受重力、落地反弹和摩擦影响，稳定后进入 sleeping 并停止逐 tick 模拟', async () => {
  const { scene, clock, player } = await createOrchard();
  const tree = nearestFruitTree(scene, player.x, player.z);
  const transform = tree.requireComponent(TRANSFORM_COMPONENT);
  moveTo(scene, transform.x + 0.5, transform.z);
  assert.equal(scene.interactWithActor('picker', { actorId: tree.id, sequence: 1 }), true);
  const drops = fruitStacks(scene);
  const start = drops.map((actor) => {
    const dropTransform = actor.requireComponent(TRANSFORM_COMPONENT);
    return { x: dropTransform.x, y: dropTransform.y, z: dropTransform.z };
  });

  clock.ms += 100;
  scene.update();
  assert.ok(drops.some((actor, index) => {
    const dropTransform = actor.requireComponent(TRANSFORM_COMPONENT);
    return dropTransform.y < start[index].y
      && Math.hypot(dropTransform.x - start[index].x, dropTransform.z - start[index].z) > 0;
  }), '果实应该一边下落一边获得可见的水平滚动位移');

  let sawBounce = false;
  for (let tick = 0; tick < 25; tick += 1) {
    clock.ms += 100;
    scene.update();
    sawBounce ||= fruitStacks(scene).some((actor) => (
      actor.requireComponent(DROP_MOTION_COMPONENT).velocityY > 0.3
      && actor.requireComponent(TRANSFORM_COMPONENT).y <= 0.141
    ));
  }
  assert.equal(sawBounce, true, '首次落地应该按恢复系数反弹');
  for (let tick = 0; tick < 75; tick += 1) {
    clock.ms += 100;
    scene.update();
  }
  const settled = fruitStacks(scene);
  assert.ok(settled.length > 0);
  for (const actor of settled) {
    const residency = actor.requireComponent(ACTOR_RESIDENCY_COMPONENT);
    const motion = actor.requireComponent(DROP_MOTION_COMPONENT);
    const dropTransform = actor.requireComponent(TRANSFORM_COMPONENT);
    assert.equal(residency.state, 'sleeping');
    assert.equal(Math.hypot(motion.velocityX, motion.velocityY, motion.velocityZ), 0);
    assert.ok(Math.abs(dropTransform.y - motion.radius) < 1e-6);
  }
});

test('冷却期间摘不到，冷却结束自己恢复', async () => {
  const { scene, clock, player } = await createOrchard();
  const tree = nearestFruitTree(scene, player.x, player.z);
  const prop = tree.requireComponent(GENERATED_PROP_COMPONENT);
  const transform = tree.requireComponent(TRANSFORM_COMPONENT);
  moveTo(scene, transform.x + 0.5, transform.z);

  assert.equal(scene.interactWithActor('picker', { actorId: tree.id, sequence: 1 }), true);
  const dropCount = fruitStacks(scene).length;
  assert.equal(scene.interactWithActor('picker', { actorId: tree.id, sequence: 2 }), false, '立刻再摘');
  assert.equal(fruitStacks(scene).length, dropCount, '被拒的那一次不该掉东西');

  // 差一秒还不行。
  clock.ms += (prop.regrowSeconds - 1) * 1000;
  assert.equal(scene.interactWithActor('picker', { actorId: tree.id, sequence: 3 }), false);

  clock.ms += 2_000;
  assert.equal(scene.interactWithActor('picker', { actorId: tree.id, sequence: 4 }), true);
  assert.equal(fruitStacks(scene).length, dropCount * 2);
});

test('冷却是绝对服务端时间：chunk 卸载期间照样走完，装回来直接是熟的', async () => {
  const { scene, clock, player } = await createOrchard();
  const tree = nearestFruitTree(scene, player.x, player.z);
  const prop = tree.requireComponent(GENERATED_PROP_COMPONENT);
  const transform = tree.requireComponent(TRANSFORM_COMPONENT);
  const treeId = tree.id;
  moveTo(scene, transform.x + 0.5, transform.z);
  assert.equal(scene.interactWithActor('picker', { actorId: treeId, sequence: 1 }), true);
  assert.equal(scene.generatedProps.deviationCount, 1);

  // 走远：Actor 卸载，冷却记录留下。
  const away = (scene.generatedProps.keepRadius + 3) * CHUNK_SIZE;
  moveTo(scene, transform.x + away, transform.z + away);
  scene.update();
  assert.equal(scene.actorWorld.getActor(treeId), undefined);
  assert.equal(scene.generatedProps.deviationCount, 1);

  // 卸载期间冷却走完；装回来时记录被丢掉，回到「没被动过」。
  clock.ms += (prop.regrowSeconds + 10) * 1000;
  moveTo(scene, transform.x + 0.5, transform.z);
  scene.update();
  const restored = scene.actorWorld.getActor(treeId);
  assert.ok(restored);
  assert.equal(restored.requireComponent(GENERATED_PROP_COMPONENT).readyAt, 0);
  assert.equal(scene.generatedProps.deviationCount, 0, '长回来的不该继续占状态');
  assert.equal(scene.interactWithActor('picker', { actorId: treeId, sequence: 2 }), true);
});

test('还在冷却里的树卸载重载后，剩余冷却不会被重置', async () => {
  const { scene, clock, player } = await createOrchard();
  const tree = nearestFruitTree(scene, player.x, player.z);
  const prop = tree.requireComponent(GENERATED_PROP_COMPONENT);
  const transform = tree.requireComponent(TRANSFORM_COMPONENT);
  const treeId = tree.id;
  moveTo(scene, transform.x + 0.5, transform.z);
  assert.equal(scene.interactWithActor('picker', { actorId: treeId, sequence: 1 }), true);
  const readyAt = prop.readyAt;

  const away = (scene.generatedProps.keepRadius + 3) * CHUNK_SIZE;
  moveTo(scene, transform.x + away, transform.z + away);
  scene.update();
  clock.ms += (prop.regrowSeconds - 20) * 1000;
  moveTo(scene, transform.x + 0.5, transform.z);
  scene.update();

  const restored = scene.actorWorld.getActor(treeId).requireComponent(GENERATED_PROP_COMPONENT);
  assert.equal(restored.readyAt, readyAt, '恢复的是同一个到期时间，不是重新计时');
  assert.equal(scene.interactWithActor('picker', { actorId: treeId, sequence: 2 }), false);
  clock.ms += 21_000;
  assert.equal(scene.interactWithActor('picker', { actorId: treeId, sequence: 3 }), true);
});

test('快照只发这一种形态用得上的字段', async () => {
  const { scene, player } = await createOrchard();
  const tree = nearestFruitTree(scene, player.x, player.z);
  const transform = tree.requireComponent(TRANSFORM_COMPONENT);
  moveTo(scene, transform.x + 0.5, transform.z);
  assert.equal(scene.interactWithActor('picker', { actorId: tree.id, sequence: 1 }), true);

  const snapshot = scene.createSnapshot('picker').actors.find((actor) => actor.id === tree.id);
  assert.equal(snapshot.propState.removed, false);
  assert.equal(typeof snapshot.propState.readyAt, 'number');
  // 可再生的没有血量；发一个恒等于 1 的 health 只会误导。
  assert.equal(snapshot.propState.health, undefined);

  // 石头那一侧相反：有血量，没有冷却。
  const rock = scene.actorWorld
    .query(GENERATED_PROP_COMPONENT)
    .find((actor) => actor.requireComponent(GENERATED_PROP_COMPONENT).kind === PROP_KIND.ROCK);
  const rockTransform = rock.requireComponent(TRANSFORM_COMPONENT);
  moveTo(scene, rockTransform.x + 0.5, rockTransform.z);
  assert.equal(scene.interactWithActor('picker', { actorId: rock.id, sequence: 2 }), true);
  const rockSnapshot = scene.createSnapshot('picker').actors.find((actor) => actor.id === rock.id);
  assert.equal(typeof rockSnapshot.propState.health, 'number');
  assert.equal(rockSnapshot.propState.readyAt, undefined);
});
