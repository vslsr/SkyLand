import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GENERATED_TREE_COMPONENT,
  ITEM_STACK_COMPONENT,
  REPLICATED_COMPONENT,
  TRANSFORM_COMPONENT,
} from '../../shared/actor/index.mjs';
import {
  deriveGeneratedTree,
  formatGeneratedTreeId,
  isPropSkipped,
  parseGeneratedTreeId,
  setPropSkipped,
} from '../../shared/world/generatedTree.mjs';
import { CHUNK_SIZE } from '../../shared/world/worldConfig.mjs';
import { SceneCatalog } from '../scenes/SceneCatalog.mjs';
import { ServerScene } from '../scene/ServerScene.mjs';

const SEED = 0x5c1a2d0b;

async function createOpenWorldScene() {
  const catalog = await SceneCatalog.load();
  return new ServerScene(catalog.require('open-world'), {
    worldSeed: SEED,
    now: () => 1_000_000,
  });
}

function residentTrees(scene) {
  return scene.actorWorld.query(GENERATED_TREE_COMPONENT, TRANSFORM_COMPONENT);
}

/** 把玩家挪到某个坐标，并按服务端的入口补上那一片的常驻内容。 */
function movePlayerTo(scene, playerId, x, z) {
  scene.players.get(playerId).setPosition(x, z);
  scene.chunkColliders.ensureAround(x, z);
  scene.generatedTrees.ensureAround(x, z);
}

function nearestTreeTo(scene, x, z) {
  return residentTrees(scene).reduce((nearest, candidate) => {
    const transform = candidate.requireComponent(TRANSFORM_COMPONENT);
    if (!nearest) return candidate;
    const nearestTransform = nearest.requireComponent(TRANSFORM_COMPONENT);
    return Math.hypot(transform.x - x, transform.z - z)
      < Math.hypot(nearestTransform.x - x, nearestTransform.z - z)
      ? candidate
      : nearest;
  }, undefined);
}

test('生成树 id 可在负 chunk 往返，并拒绝不存在的 prop', () => {
  const id = formatGeneratedTreeId(-3, 2, 17);
  assert.equal(id, 'tree:-3:2:17');
  assert.deepEqual(parseGeneratedTreeId(id), { chunkX: -3, chunkZ: 2, propIndex: 17 });
  assert.equal(parseGeneratedTreeId('tree:99:2:17'), undefined);
  assert.equal(deriveGeneratedTree(SEED, -3, 2, 63), undefined);
  const mask = setPropSkipped(undefined, 47, true);
  assert.equal(isPropSkipped(47, mask), true);
  assert.equal(isPropSkipped(15, mask), false);
});

test('空房间不建任何树，玩家到场才装载他周围的那一片', async () => {
  const scene = await createOpenWorldScene();
  assert.equal(residentTrees(scene).length, 0);
  assert.equal(scene.generatedTrees.residentChunkCount, 0);

  scene.addPlayer({ id: 'woodcutter', name: '樵夫', slot: 0 });
  const resident = residentTrees(scene);
  assert.ok(resident.length > 0, '玩家出生点周围应该有树');

  // 常驻半径至少要覆盖复制半径，否则 AOI 里的树没有 Actor 可复制偏离态。
  const archetype = scene.generatedTrees.archetype;
  assert.ok(
    scene.generatedTrees.residentRadius >= archetype.components.replicationPolicy.radiusChunks,
  );
  assert.ok(scene.generatedTrees.keepRadius > scene.generatedTrees.residentRadius);

  // 常驻集合是玩家周围的一圈，不是全世界。
  const player = scene.players.get('woodcutter');
  const reach = (scene.generatedTrees.residentRadius + 1) * CHUNK_SIZE;
  for (const actor of resident) {
    const transform = actor.requireComponent(TRANSFORM_COMPONENT);
    assert.ok(
      Math.abs(transform.x - player.x) <= reach && Math.abs(transform.z - player.z) <= reach,
      `树 ${actor.id} 落在常驻范围之外`,
    );
  }
  assert.equal(resident.length, scene.generatedTrees.residentActorCount);
});

test('默认树是无网格轻量 Actor，受损后才复制，倒下时移除碰撞并生成木材', async () => {
  const scene = await createOpenWorldScene();
  scene.addPlayer({ id: 'woodcutter', name: '樵夫', slot: 0 });
  const player = scene.players.get('woodcutter');

  const treeActor = nearestTreeTo(scene, player.x, player.z);
  assert.ok(treeActor);
  assert.equal(treeActor.hasComponents(REPLICATED_COMPONENT), false);
  assert.equal(
    scene.createSnapshot().actors.some((actor) => actor.id === treeActor.id),
    false,
  );

  const transform = treeActor.requireComponent(TRANSFORM_COMPONENT);
  const tree = treeActor.requireComponent(GENERATED_TREE_COMPONENT);
  movePlayerTo(scene, 'woodcutter', transform.x + 0.5, transform.z);

  assert.equal(scene.interactWithActor('woodcutter', { actorId: treeActor.id, sequence: 1 }), true);
  const damaged = scene.createSnapshot('woodcutter').actors.find((actor) => actor.id === treeActor.id);
  assert.ok(damaged);
  assert.equal(damaged.transform, undefined);
  assert.equal(damaged.treeState.health, tree.maximumHealth - tree.chopDamage);

  let sequence = 2;
  while (!tree.removed) {
    assert.equal(scene.interactWithActor('woodcutter', { actorId: treeActor.id, sequence }), true);
    sequence += 1;
  }
  assert.equal(scene.chunkColliders.getSkipMask(tree.chunkX, tree.chunkZ).low !== 0
    || scene.chunkColliders.getSkipMask(tree.chunkX, tree.chunkZ).high !== 0, true);
  const snapshot = scene.createSnapshot('woodcutter');
  const removed = snapshot.actors.find((actor) => actor.id === treeActor.id);
  assert.deepEqual(removed.treeState, { health: 0, removed: true });
  const wood = scene.actorWorld.query(ITEM_STACK_COMPONENT).find((actor) => (
    actor.requireComponent(ITEM_STACK_COMPONENT).itemType === 'wood'
  ));
  assert.ok(wood);
  assert.equal(wood.requireComponent(ITEM_STACK_COMPONENT).quantity, tree.woodQuantity);
  assert.equal(scene.interactWithActor('woodcutter', { actorId: treeActor.id, sequence }), false);
});

test('砍到一半的树在 chunk 卸载重载后保持偏离态，完好的树不占状态', async () => {
  const scene = await createOpenWorldScene();
  scene.addPlayer({ id: 'woodcutter', name: '樵夫', slot: 0 });
  const player = scene.players.get('woodcutter');

  const treeActor = nearestTreeTo(scene, player.x, player.z);
  const transform = treeActor.requireComponent(TRANSFORM_COMPONENT);
  const tree = treeActor.requireComponent(GENERATED_TREE_COMPONENT);
  const treeId = treeActor.id;
  const maximumHealth = tree.maximumHealth;
  movePlayerTo(scene, 'woodcutter', transform.x + 0.5, transform.z);

  assert.equal(scene.interactWithActor('woodcutter', { actorId: treeId, sequence: 1 }), true);
  assert.equal(scene.generatedTrees.deviationCount, 1);

  // 走出 keepRadius：这一片连同它的树一起卸载，偏离态留下。
  const away = (scene.generatedTrees.keepRadius + 3) * CHUNK_SIZE;
  movePlayerTo(scene, 'woodcutter', transform.x + away, transform.z + away);
  scene.update();
  assert.equal(scene.actorWorld.getActor(treeId), undefined);
  assert.equal(scene.generatedTrees.deviationCount, 1);
  // 只有被动过的那一棵留下记录，同一片里完好的树不占状态。
  assert.ok(scene.generatedTrees.residentActorCount > 1);

  // 走回来：同一个 id 带着砍过的血量回到世界，并且立刻可复制。
  movePlayerTo(scene, 'woodcutter', transform.x + 0.5, transform.z);
  scene.update();
  const restored = scene.actorWorld.getActor(treeId);
  assert.ok(restored, '树应该按同一个 id 恢复');
  const restoredTree = restored.requireComponent(GENERATED_TREE_COMPONENT);
  assert.equal(restoredTree.health, maximumHealth - tree.chopDamage);
  assert.equal(restoredTree.removed, false);
  assert.equal(restored.hasComponents(REPLICATED_COMPONENT), true);
  const restoredSnapshot = scene.createSnapshot('woodcutter').actors.find((actor) => actor.id === treeId);
  assert.equal(restoredSnapshot.treeState.health, maximumHealth - tree.chopDamage);
});

test('倒下的树重新装载后仍然是倒下的，不会原地长回来', async () => {
  const scene = await createOpenWorldScene();
  scene.addPlayer({ id: 'woodcutter', name: '樵夫', slot: 0 });
  const player = scene.players.get('woodcutter');

  const treeActor = nearestTreeTo(scene, player.x, player.z);
  const transform = treeActor.requireComponent(TRANSFORM_COMPONENT);
  const tree = treeActor.requireComponent(GENERATED_TREE_COMPONENT);
  const treeId = treeActor.id;
  movePlayerTo(scene, 'woodcutter', transform.x + 0.5, transform.z);

  let sequence = 1;
  while (!tree.removed) {
    assert.equal(scene.interactWithActor('woodcutter', { actorId: treeId, sequence }), true);
    sequence += 1;
  }

  const away = (scene.generatedTrees.keepRadius + 3) * CHUNK_SIZE;
  movePlayerTo(scene, 'woodcutter', transform.x + away, transform.z + away);
  scene.update();
  movePlayerTo(scene, 'woodcutter', transform.x + 0.5, transform.z);
  scene.update();

  const restored = scene.actorWorld.getActor(treeId);
  assert.ok(restored);
  const restoredTree = restored.requireComponent(GENERATED_TREE_COMPONENT);
  assert.equal(restoredTree.removed, true);
  assert.equal(restoredTree.health, 0);
  // 快照必须继续带着 removed，否则客户端会把它画回来。
  const snapshot = scene.createSnapshot('woodcutter').actors.find((actor) => actor.id === treeId);
  assert.deepEqual(snapshot.treeState, { health: 0, removed: true });
  // 已经倒下的树不能再砍出第二份木材。
  assert.equal(scene.interactWithActor('woodcutter', { actorId: treeId, sequence }), false);
});
