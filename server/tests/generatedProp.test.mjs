import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ELASTIC_TETHER_COMPONENT,
  GENERATED_PROP_COMPONENT,
  INVENTORY_COMPONENT,
  ITEM_STACK_COMPONENT,
  REPLICATED_COMPONENT,
  TRANSFORM_COMPONENT,
} from '../../shared/actor/index.mjs';
import {
  deriveGeneratedProp,
  formatGeneratedPropId,
  isPropSkipped,
  parseGeneratedPropId,
  setPropSkipped,
} from '../../shared/world/generatedProp.mjs';
import {
  CHUNK_SIZE,
  MAXIMUM_CHUNK_COORDINATE,
  MAXIMUM_PROPS_PER_CHUNK,
  PROP_KIND,
} from '../../shared/world/worldConfig.mjs';
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

function residentProps(scene, kind) {
  const actors = scene.actorWorld.query(GENERATED_PROP_COMPONENT, TRANSFORM_COMPONENT);
  if (kind === undefined) return actors;
  return actors.filter((actor) => actor.requireComponent(GENERATED_PROP_COMPONENT).kind === kind);
}

function residentTrees(scene) {
  return residentProps(scene, PROP_KIND.TREE);
}

/** 把玩家挪到某个坐标，并按服务端的入口补上那一片的常驻内容。 */
function movePlayerTo(scene, playerId, x, z) {
  scene.players.get(playerId).setPosition(x, z);
  scene.chunkColliders.ensureAround(x, z);
  scene.generatedProps.ensureAround(x, z);
}

function nearestPropTo(scene, x, z, kind) {
  return residentProps(scene, kind).reduce((nearest, candidate) => {
    const transform = candidate.requireComponent(TRANSFORM_COMPONENT);
    if (!nearest) return candidate;
    const nearestTransform = nearest.requireComponent(TRANSFORM_COMPONENT);
    return Math.hypot(transform.x - x, transform.z - z)
      < Math.hypot(nearestTransform.x - x, nearestTransform.z - z)
      ? candidate
      : nearest;
  }, undefined);
}

function nearestTreeTo(scene, x, z) {
  return nearestPropTo(scene, x, z, PROP_KIND.TREE);
}

/** 反复交互直到物件被采完，返回下一个可用的序号。 */
function harvestUntilRemoved(scene, playerId, actorId, prop, startSequence = 1) {
  let sequence = startSequence;
  while (!prop.removed) {
    assert.equal(scene.interactWithActor(playerId, { actorId, sequence }), true);
    sequence += 1;
  }
  return sequence;
}

test('生成物件 id 带种类、可在负 chunk 往返，并拒绝越界与未知种类', () => {
  const id = formatGeneratedPropId(PROP_KIND.TREE, -3, 2, 17);
  assert.equal(id, 'prop:tree:-3:2:17');
  assert.deepEqual(parseGeneratedPropId(id), {
    kind: PROP_KIND.TREE,
    chunkX: -3,
    chunkZ: 2,
    propIndex: 17,
  });
  assert.equal(formatGeneratedPropId(PROP_KIND.ROCK, 0, 0, 3), 'prop:rock:0:0:3');
  assert.equal(formatGeneratedPropId(PROP_KIND.MUSHROOM, 0, 0, 4), 'prop:mushroom:0:0:4');
  // 越界的只有精度护栏之外那一格；99 号 chunk（约 3 公里外）是正常世界的一部分。
  assert.deepEqual(parseGeneratedPropId('prop:tree:99:2:17')?.chunkX, 99);
  assert.equal(
    parseGeneratedPropId(`prop:tree:${MAXIMUM_CHUNK_COORDINATE + 1}:2:17`),
    undefined,
    'chunk 越界',
  );
  assert.equal(parseGeneratedPropId('prop:dragon:0:0:1'), undefined, '未知种类');
  assert.equal(parseGeneratedPropId('tree:0:0:1'), undefined, '旧格式不再被接受');
  assert.equal(deriveGeneratedProp(SEED, -3, 2, 63), undefined);
  const mask = setPropSkipped(undefined, 47, true);
  assert.equal(isPropSkipped(47, mask), true);
  assert.equal(isPropSkipped(15, mask), false);
});

test('deriveGeneratedProp 报告放置记录里真实的种类', () => {
  const kinds = new Set();
  for (let propIndex = 0; propIndex < MAXIMUM_PROPS_PER_CHUNK; propIndex += 1) {
    const derived = deriveGeneratedProp(SEED, 0, 0, propIndex);
    if (!derived) continue;
    kinds.add(derived.kind);
    // id 里写的种类必须和推导出来的一致，否则注册表会挑错原型。
    assert.equal(parseGeneratedPropId(derived.id).kind, derived.kind);
  }
  assert.ok(kinds.size > 1, '同一个 chunk 里应该有不止一种物件');
});

test('空房间不建任何物件，玩家到场才装载他周围的那一片', async () => {
  const scene = await createOpenWorldScene();
  assert.equal(residentProps(scene).length, 0);
  assert.equal(scene.generatedProps.residentChunkCount, 0);

  scene.addPlayer({ id: 'woodcutter', name: '樵夫', slot: 0 });
  const resident = residentProps(scene);
  const mushrooms = scene.actorWorld.query(ELASTIC_TETHER_COMPONENT);
  assert.ok(residentTrees(scene).length > 0, '玩家出生点周围应该有树');
  assert.ok(residentProps(scene, PROP_KIND.ROCK).length > 0, '也应该有石头');
  assert.ok(mushrooms.length > 0, '也应该有完整复制的弹性蘑菇 Actor');
  const mushroomSnapshot = scene.createSnapshot('woodcutter').actors.find(
    (actor) => actor.archetypeId === 'elastic-mushroom',
  );
  assert.ok(mushroomSnapshot);
  assert.ok(mushroomSnapshot.id.startsWith('prop:mushroom:'));
  assert.equal(mushroomSnapshot.propState, undefined);
  assert.equal(mushroomSnapshot.interactable.action, 'mushroom-bite');
  assert.equal(mushroomSnapshot.elasticTether.holderPlayerId, null);
  const mushroomActor = mushrooms.find((actor) => actor.id === mushroomSnapshot.id);
  const mushroomTransform = mushroomActor.requireComponent(TRANSFORM_COMPONENT);
  scene.physics.removeCharacter('woodcutter');
  const capHit = scene.physics.castRay(
    { x: mushroomTransform.x, y: mushroomTransform.y + 2, z: mushroomTransform.z },
    { x: 0, y: -1, z: 0 },
    3,
  );
  assert.ok(capHit, '生成蘑菇挂载后应立即进入服务端 Rapier 查询');
  assert.ok(
    Math.abs((mushroomTransform.y + 2 - capHit.timeOfImpact) - (mushroomTransform.y + 0.95)) < 0.01,
    `向下射线应先命中可站立菌盖，而不是 y=${mushroomTransform.y + 2 - capHit.timeOfImpact}`,
  );

  // 常驻半径至少要覆盖复制半径，否则 AOI 里的树没有 Actor 可复制偏离态。
  const archetype = scene.generatedProps.archetypeForKind(PROP_KIND.TREE);
  assert.ok(
    scene.generatedProps.residentRadius >= archetype.components.replicationPolicy.radiusChunks,
  );
  assert.ok(scene.generatedProps.keepRadius > scene.generatedProps.residentRadius);

  // 常驻集合是玩家周围的一圈，不是全世界；两种物件走同一套半径。
  const player = scene.players.get('woodcutter');
  const reach = (scene.generatedProps.residentRadius + 1) * CHUNK_SIZE;
  for (const actor of [...resident, ...mushrooms]) {
    const transform = actor.requireComponent(TRANSFORM_COMPONENT);
    assert.ok(
      Math.abs(transform.x - player.x) <= reach && Math.abs(transform.z - player.z) <= reach,
      `物件 ${actor.id} 落在常驻范围之外`,
    );
  }
  assert.equal(resident.length + mushrooms.length, scene.generatedProps.residentActorCount);
});

test('默认树倒下时从树中心逐根生成带物理效果的木头', async () => {
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
  const tree = treeActor.requireComponent(GENERATED_PROP_COMPONENT);
  movePlayerTo(scene, 'woodcutter', transform.x + 0.5, transform.z);

  assert.equal(scene.interactWithActor('woodcutter', { actorId: treeActor.id, sequence: 1 }), true);
  const damaged = scene.createSnapshot('woodcutter').actors.find((actor) => actor.id === treeActor.id);
  assert.ok(damaged);
  assert.equal(damaged.transform, undefined);
  assert.equal(damaged.propState.health, tree.maximumHealth - tree.harvestDamage);

  let sequence = 2;
  while (!tree.removed) {
    assert.equal(scene.interactWithActor('woodcutter', { actorId: treeActor.id, sequence }), true);
    sequence += 1;
  }
  assert.equal(scene.chunkColliders.getSkipMask(tree.chunkX, tree.chunkZ).low !== 0
    || scene.chunkColliders.getSkipMask(tree.chunkX, tree.chunkZ).high !== 0, true);
  const snapshot = scene.createSnapshot('woodcutter');
  const removed = snapshot.actors.find((actor) => actor.id === treeActor.id);
  assert.deepEqual(removed.propState, { health: 0, removed: true });
  const logs = scene.actorWorld.query(ITEM_STACK_COMPONENT, TRANSFORM_COMPONENT).filter((actor) => (
    actor.archetypeId === 'wood-pile'
    && actor.requireComponent(ITEM_STACK_COMPONENT).itemType === 'wood'
  ));
  assert.equal(logs.length, tree.dropQuantity, '默认掉落数量应拆成等量的独立木头 Actor');
  assert.equal(
    logs.reduce((total, actor) => (
      total + actor.requireComponent(ITEM_STACK_COMPONENT).quantity
    ), 0),
    tree.dropQuantity,
  );
  const expectedOriginY = transform.y + tree.scale * 1.95;
  for (const log of logs) {
    const logTransform = log.requireComponent(TRANSFORM_COMPONENT);
    assert.equal(logTransform.x, transform.x, '木头应从树中心出生');
    assert.equal(logTransform.y, expectedOriginY);
    assert.equal(logTransform.z, transform.z, '木头应从树中心出生');
    assert.equal(log.requireComponent(ITEM_STACK_COMPONENT).quantity, 1);
  }
  assert.equal(scene.interactWithActor('woodcutter', { actorId: treeActor.id, sequence }), false);
});

test('砍到一半的树在 chunk 卸载重载后保持偏离态，完好的树不占状态', async () => {
  const scene = await createOpenWorldScene();
  scene.addPlayer({ id: 'woodcutter', name: '樵夫', slot: 0 });
  const player = scene.players.get('woodcutter');

  const treeActor = nearestTreeTo(scene, player.x, player.z);
  const transform = treeActor.requireComponent(TRANSFORM_COMPONENT);
  const tree = treeActor.requireComponent(GENERATED_PROP_COMPONENT);
  const treeId = treeActor.id;
  const maximumHealth = tree.maximumHealth;
  movePlayerTo(scene, 'woodcutter', transform.x + 0.5, transform.z);

  assert.equal(scene.interactWithActor('woodcutter', { actorId: treeId, sequence: 1 }), true);
  assert.equal(scene.generatedProps.deviationCount, 1);

  // 走出 keepRadius：这一片连同它的树一起卸载，偏离态留下。
  const away = (scene.generatedProps.keepRadius + 3) * CHUNK_SIZE;
  movePlayerTo(scene, 'woodcutter', transform.x + away, transform.z + away);
  scene.update();
  assert.equal(scene.actorWorld.getActor(treeId), undefined);
  assert.equal(scene.generatedProps.deviationCount, 1);
  // 只有被动过的那一棵留下记录，同一片里完好的树不占状态。
  assert.ok(scene.generatedProps.residentActorCount > 1);

  // 走回来：同一个 id 带着砍过的血量回到世界，并且立刻可复制。
  movePlayerTo(scene, 'woodcutter', transform.x + 0.5, transform.z);
  scene.update();
  const restored = scene.actorWorld.getActor(treeId);
  assert.ok(restored, '树应该按同一个 id 恢复');
  const restoredTree = restored.requireComponent(GENERATED_PROP_COMPONENT);
  assert.equal(restoredTree.health, maximumHealth - tree.harvestDamage);
  assert.equal(restoredTree.removed, false);
  assert.equal(restored.hasComponents(REPLICATED_COMPONENT), true);
  const restoredSnapshot = scene.createSnapshot('woodcutter').actors.find((actor) => actor.id === treeId);
  assert.equal(restoredSnapshot.propState.health, maximumHealth - tree.harvestDamage);
});

test('倒下的树重新装载后仍然是倒下的，不会原地长回来', async () => {
  const scene = await createOpenWorldScene();
  scene.addPlayer({ id: 'woodcutter', name: '樵夫', slot: 0 });
  const player = scene.players.get('woodcutter');

  const treeActor = nearestTreeTo(scene, player.x, player.z);
  const transform = treeActor.requireComponent(TRANSFORM_COMPONENT);
  const tree = treeActor.requireComponent(GENERATED_PROP_COMPONENT);
  const treeId = treeActor.id;
  movePlayerTo(scene, 'woodcutter', transform.x + 0.5, transform.z);

  let sequence = 1;
  while (!tree.removed) {
    assert.equal(scene.interactWithActor('woodcutter', { actorId: treeId, sequence }), true);
    sequence += 1;
  }

  const away = (scene.generatedProps.keepRadius + 3) * CHUNK_SIZE;
  movePlayerTo(scene, 'woodcutter', transform.x + away, transform.z + away);
  scene.update();
  movePlayerTo(scene, 'woodcutter', transform.x + 0.5, transform.z);
  scene.update();

  const restored = scene.actorWorld.getActor(treeId);
  assert.ok(restored);
  const restoredTree = restored.requireComponent(GENERATED_PROP_COMPONENT);
  assert.equal(restoredTree.removed, true);
  assert.equal(restoredTree.health, 0);
  // 快照必须继续带着 removed，否则客户端会把它画回来。
  const snapshot = scene.createSnapshot('woodcutter').actors.find((actor) => actor.id === treeId);
  assert.deepEqual(snapshot.propState, { health: 0, removed: true });
  // 已经倒下的树不能再砍出第二份木头。
  assert.equal(scene.interactWithActor('woodcutter', { actorId: treeId, sequence }), false);
});


test('石头走的是同一条采集链路，掉的是石料而不是木头', async () => {
  const scene = await createOpenWorldScene();
  scene.addPlayer({ id: 'miner', name: '矿工', slot: 0 });
  const player = scene.players.get('miner');

  // 树和石头都常驻，说明注册表两种原型都认领到了。
  assert.ok(residentProps(scene, PROP_KIND.TREE).length > 0);
  assert.ok(residentProps(scene, PROP_KIND.ROCK).length > 0);

  const rockActor = nearestPropTo(scene, player.x, player.z, PROP_KIND.ROCK);
  assert.ok(rockActor);
  assert.equal(rockActor.archetypeId, 'large-rock');
  assert.equal(rockActor.id.startsWith('prop:rock:'), true);

  const transform = rockActor.requireComponent(TRANSFORM_COMPONENT);
  const rock = rockActor.requireComponent(GENERATED_PROP_COMPONENT);
  movePlayerTo(scene, 'miner', transform.x + 0.5, transform.z);

  // 大石头比树硬：血量取自 large-rock.actor.json，不是代码里的常数。
  assert.equal(rock.maximumHealth, 5);
  const sequence = harvestUntilRemoved(scene, 'miner', rockActor.id, rock);

  const stone = scene.actorWorld.query(ITEM_STACK_COMPONENT).find((actor) => (
    actor.requireComponent(ITEM_STACK_COMPONENT).itemType === 'stone'
  ));
  assert.ok(stone, '应该掉出石料');
  assert.equal(stone.archetypeId, 'stone-pile');
  assert.equal(stone.requireComponent(ITEM_STACK_COMPONENT).quantity, rock.dropQuantity);
  // 采石头不应该顺带掉木头。
  assert.equal(
    scene.actorWorld.query(ITEM_STACK_COMPONENT).some((actor) => (
      actor.requireComponent(ITEM_STACK_COMPONENT).itemType === 'wood'
    )),
    false,
  );

  // 静态碰撞跟着一起消失，玩家能走到原来的位置上。
  const mask = scene.chunkColliders.getSkipMask(rock.chunkX, rock.chunkZ);
  assert.equal(mask.low !== 0 || mask.high !== 0, true);
  assert.equal(scene.interactWithActor('miner', { actorId: rockActor.id, sequence }), false);
});

test('同一个玩家采树和采石得到两种不同的物品', async () => {
  const scene = await createOpenWorldScene();
  scene.addPlayer({ id: 'miner', name: '矿工', slot: 0 });
  const player = scene.players.get('miner');
  const inventory = player.requireComponent(INVENTORY_COMPONENT);

  let sequence = 1;
  for (const kind of [PROP_KIND.TREE, PROP_KIND.ROCK]) {
    const actor = nearestPropTo(scene, player.x, player.z, kind);
    const transform = actor.requireComponent(TRANSFORM_COMPONENT);
    const prop = actor.requireComponent(GENERATED_PROP_COMPONENT);
    movePlayerTo(scene, 'miner', transform.x + 0.5, transform.z);
    sequence = harvestUntilRemoved(scene, 'miner', actor.id, prop, sequence);

    const drop = scene.actorWorld.query(ITEM_STACK_COMPONENT).find((candidate) => (
      candidate.requireComponent(ITEM_STACK_COMPONENT).quantity > 0
      && candidate.archetypeId === prop.dropArchetypeId
    ));
    assert.ok(drop, `${prop.dropArchetypeId} 应该掉出来`);
    const dropTransform = drop.requireComponent(TRANSFORM_COMPONENT);
    movePlayerTo(scene, 'miner', dropTransform.x, dropTransform.z);
    assert.equal(scene.interactWithActor('miner', { actorId: drop.id, sequence }), true);
    sequence += 1;
  }

  // 捡起来的东西先进物品栏：先采树后采石，所以木头在前一格、石头在后一格。
  assert.deepEqual(
    inventory.hotbar.filter((slot) => slot !== null).map((slot) => slot.itemType),
    ['wood', 'stone'],
    '两种物品分别入账，没有被当成同一种堆叠',
  );
});
import './initRapier.mjs';
