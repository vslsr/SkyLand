import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GENERATED_PROP_COMPONENT,
  ITEM_STACK_COMPONENT,
  TRANSFORM_COMPONENT,
} from '../../shared/actor/index.mjs';
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

test('摘果子不砍树：树留在原地，静态碰撞一点没动', async () => {
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
  assert.equal(fruitStacks(scene).length, 1);
});

test('冷却期间摘不到，冷却结束自己恢复', async () => {
  const { scene, clock, player } = await createOrchard();
  const tree = nearestFruitTree(scene, player.x, player.z);
  const prop = tree.requireComponent(GENERATED_PROP_COMPONENT);
  const transform = tree.requireComponent(TRANSFORM_COMPONENT);
  moveTo(scene, transform.x + 0.5, transform.z);

  assert.equal(scene.interactWithActor('picker', { actorId: tree.id, sequence: 1 }), true);
  assert.equal(scene.interactWithActor('picker', { actorId: tree.id, sequence: 2 }), false, '立刻再摘');
  assert.equal(fruitStacks(scene).length, 1, '被拒的那一次不该掉东西');

  // 差一秒还不行。
  clock.ms += (prop.regrowSeconds - 1) * 1000;
  assert.equal(scene.interactWithActor('picker', { actorId: tree.id, sequence: 3 }), false);

  clock.ms += 2_000;
  assert.equal(scene.interactWithActor('picker', { actorId: tree.id, sequence: 4 }), true);
  assert.equal(fruitStacks(scene).length, 2);
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
