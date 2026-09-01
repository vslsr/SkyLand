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
import { SceneCatalog } from '../scenes/SceneCatalog.mjs';
import { ServerScene } from '../scene/ServerScene.mjs';

const SEED = 0x5c1a2d0b;

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

test('默认树是无网格轻量 Actor，受损后才复制，倒下时移除碰撞并生成木材', async () => {
  const catalog = await SceneCatalog.load();
  const scene = new ServerScene(catalog.require('open-world'), {
    worldSeed: SEED,
    now: () => 1_000_000,
  });
  const trees = scene.actorWorld.query(GENERATED_TREE_COMPONENT, TRANSFORM_COMPONENT);
  assert.equal(trees.length, scene.generatedTreeCount);
  assert.ok(trees.length > 100);
  assert.equal(trees.some((actor) => actor.hasComponents(REPLICATED_COMPONENT)), false);
  assert.equal(scene.createSnapshot().actors.some((actor) => actor.archetypeId === 'generated-tree'), false);

  const treeActor = trees.reduce((nearest, candidate) => {
    const transform = candidate.requireComponent(TRANSFORM_COMPONENT);
    const nearestTransform = nearest.requireComponent(TRANSFORM_COMPONENT);
    return Math.hypot(transform.x, transform.z) < Math.hypot(nearestTransform.x, nearestTransform.z)
      ? candidate
      : nearest;
  });
  const transform = treeActor.requireComponent(TRANSFORM_COMPONENT);
  const tree = treeActor.requireComponent(GENERATED_TREE_COMPONENT);
  scene.addPlayer({ id: 'woodcutter', name: '樵夫', slot: 0 });
  const player = scene.players.get('woodcutter');
  player.setPosition(transform.x + 0.5, transform.z);
  scene.chunkColliders.ensureAround(transform.x, transform.z);

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
