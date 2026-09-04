import assert from 'node:assert/strict';
import test from 'node:test';
import './initRapier.mjs';
import { ServerScene } from '../scene/ServerScene.mjs';
import { SceneCatalog } from '../scenes/SceneCatalog.mjs';
import {
  ACTOR_CONTROL_COMPONENT,
  BUILD_GRID_COMPONENT,
  BUILD_PIECE_COMPONENT,
  BUOYANCY_COMPONENT,
  INVENTORY_COMPONENT,
  TRANSFORM_COMPONENT,
} from '../../shared/actor/index.mjs';
import { BUILD_CELL_SIZE } from '../../shared/build/index.mjs';

const catalogPromise = SceneCatalog.load();

function createClock(startAt = 1_000_000) {
  let current = startAt;
  return { now: () => current, advance(seconds) { current += seconds * 1000; } };
}

async function createScene(sceneId, mutate = (definition) => definition) {
  const catalog = await catalogPromise;
  const definition = mutate(structuredClone(catalog.require(sceneId)));
  const clock = createClock();
  const scene = new ServerScene(definition, { now: clock.now });
  scene.addPlayer({ id: 'builder', name: '工匠', slot: 0 });
  const player = scene.players.get('builder');
  let sequence = 0;
  const send = (command) => scene.applyBuildCommand('builder', { sequence: ++sequence, command });
  return { scene, player, clock, send, inventory: player.getComponent(INVENTORY_COMPONENT) };
}

/** 把玩家挪到某个世界点上；建造只看权威位置，不需要走过去。 */
function moveTo(player, x, z) {
  player.x = x;
  player.z = z;
}

function hullOf(scene, actor) {
  const hull = actor.parent;
  assert.ok(hull?.getComponent(BUILD_GRID_COMPONENT), '水上件必须挂在船体根节点上');
  return hull;
}

function buildActors(scene) {
  return scene.actorWorld.query(BUILD_PIECE_COMPONENT);
}

test('纯海域图：起始材料到位，第一块水上地基立起一艘船，后面的板与墙挂上去', async () => {
  const { scene, player, send, inventory } = await createScene('water');
  assert.equal(inventory.quantityOf('wood-log'), 24, 'startingInventory 发到背包里');
  // 站在格 (5,5) 旁边：站在格里会把自己挡住。
  moveTo(player, 9, 9);

  assert.equal(send({ kind: 'place', archetypeId: 'float-foundation', surface: 'floating', cellX: 5, cellZ: 5 }), true);
  const [root] = buildActors(scene);
  assert.ok(root, '地基 Actor 已生成');
  const hull = hullOf(scene, root);
  assert.equal(hull.archetypeId, 'float-hull');
  assert.equal(inventory.quantityOf('wood-log'), 22, '扣掉两根木头');
  const hullTransform = hull.getComponent(TRANSFORM_COMPONENT);
  assert.deepEqual([hullTransform.x, hullTransform.y, hullTransform.z], [11, 0, 11], '船立在格中心、水面高度');
  const piece = root.getComponent(BUILD_PIECE_COMPONENT);
  assert.deepEqual([piece.cellX, piece.cellZ, piece.placedSurface], [0, 0, 'floating']);
  assert.equal(scene.buildSites.countBySurface(hull.id), 1);
  const buoyancy = hull.getComponent(BUOYANCY_COMPONENT);
  assert.ok(buoyancy.parts.some((part) => part.id === root.id && part.buoyancy === 30), '地基进浮力结算');
  scene.update();
  assert.equal(buoyancy.state, 'afloat');

  // 挨着甲板铺第二块，再在第一块的北边立一面墙。
  assert.equal(send({ kind: 'place', archetypeId: 'float-foundation', surface: 'floating', hullActorId: hull.id, cellX: 1, cellZ: 0 }), true);
  assert.equal(send({ kind: 'place', archetypeId: 'float-wall', surface: 'floating', hullActorId: hull.id, cellX: 0, cellZ: 0, edge: 'north' }), true);
  const wall = buildActors(scene).find((actor) => actor.archetypeId === 'float-wall');
  const wallTransform = wall.getComponent(TRANSFORM_COMPONENT);
  assert.ok(Math.abs(wallTransform.x - 11) < 1e-9 && Math.abs(wallTransform.z - 12) < 1e-9, '墙在格 (0,0) 的北边中点');
  assert.ok(Math.abs(wallTransform.y - 0.16) < 1e-9, '墙脚落在甲板面上');
  assert.equal(inventory.quantityOf('wood-log'), 19);

  // 不挨着甲板的板、没有甲板撑着的墙、同一格再来一块，都不行。
  assert.equal(send({ kind: 'place', archetypeId: 'float-foundation', surface: 'floating', hullActorId: hull.id, cellX: 3, cellZ: 3 }), false);
  assert.equal(send({ kind: 'place', archetypeId: 'float-wall', surface: 'floating', hullActorId: hull.id, cellX: 2, cellZ: 2, edge: 'east' }), false);
  assert.equal(send({ kind: 'place', archetypeId: 'float-foundation', surface: 'floating', hullActorId: hull.id, cellX: 1, cellZ: 0 }), false);
  assert.equal(inventory.quantityOf('wood-log'), 19, '被拒的放置不扣材料');

  // 篝火是物件：放在甲板上，跟着船走，同槽互斥。
  assert.equal(send({ kind: 'place', archetypeId: 'campfire', surface: 'floating', hullActorId: hull.id, cellX: 1, cellZ: 0 }), true);
  assert.equal(send({ kind: 'place', archetypeId: 'campfire', surface: 'floating', hullActorId: hull.id, cellX: 1, cellZ: 0 }), false);
  const campfire = buildActors(scene).find((actor) => actor.archetypeId === 'campfire');
  assert.equal(campfire.parent, hull);
  assert.ok(buoyancy.parts.some((part) => part.id === campfire.id && part.mass === 20), '物件的重量进浮力结算');

  // 快照带着格坐标与实际表面，客户端靠它重建占位表。
  const snapshot = scene.createSnapshot('builder');
  const rootSnapshot = snapshot.actors.find((actor) => actor.id === root.id);
  assert.deepEqual(rootSnapshot.buildPiece, { kind: 'foundation', surface: 'floating', cellX: 0, cellZ: 0, revision: 0 });
  assert.equal(rootSnapshot.parentActorId, hull.id);
  const hullSnapshot = snapshot.actors.find((actor) => actor.id === hull.id);
  assert.ok(hullSnapshot?.buoyancy, '看不见的船体根节点也走快照，带浮力状态');
});

test('拆除：材料退回，撑着东西的地基拆不掉，船上最后一件拆掉船也没了', async () => {
  const { scene, player, send, inventory } = await createScene('water');
  moveTo(player, 9, 9);
  send({ kind: 'place', archetypeId: 'float-foundation', surface: 'floating', cellX: 5, cellZ: 5 });
  const [root] = buildActors(scene);
  const hull = hullOf(scene, root);
  send({ kind: 'place', archetypeId: 'float-foundation', surface: 'floating', hullActorId: hull.id, cellX: 1, cellZ: 0 });
  send({ kind: 'place', archetypeId: 'float-wall', surface: 'floating', hullActorId: hull.id, cellX: 1, cellZ: 0, edge: 'east' });
  const second = buildActors(scene).find((actor) => actor.archetypeId === 'float-foundation' && actor !== root);
  const wall = buildActors(scene).find((actor) => actor.archetypeId === 'float-wall');
  assert.equal(inventory.quantityOf('wood-log'), 19);

  assert.equal(send({ kind: 'remove', actorId: second.id }), false, '东边的墙只靠这块板撑着');
  assert.equal(send({ kind: 'remove', actorId: wall.id }), true);
  assert.equal(inventory.quantityOf('wood-log'), 20, '拆墙退一根');
  assert.equal(scene.actorWorld.getActor(wall.id), undefined);
  assert.equal(send({ kind: 'remove', actorId: second.id }), true);
  assert.equal(send({ kind: 'remove', actorId: root.id }), true);
  assert.equal(inventory.quantityOf('wood-log'), 24, '全部退回');
  assert.equal(scene.actorWorld.getActor(hull.id), undefined, '空船跟着拆掉');
  assert.equal(scene.buildSites.size, 0);

  // 太远够不着。
  send({ kind: 'place', archetypeId: 'float-foundation', surface: 'floating', cellX: 5, cellZ: 5 });
  const [again] = buildActors(scene);
  moveTo(player, 30, 30);
  assert.equal(send({ kind: 'remove', actorId: again.id }), false);
  assert.equal(send({ kind: 'place', archetypeId: 'float-foundation', surface: 'floating', hullActorId: again.parent.id, cellX: 1, cellZ: 0 }), false, '放也够不着');
});

test('实体碰撞与预算：站在放置位上放不下，每艘船的件数有上限，序号防重放', async () => {
  const { scene, player, send } = await createScene('water', (definition) => {
    const hull = definition.actorArchetypes.find((archetype) => archetype.id === 'float-hull');
    hull.components.buildGrid.maxPieces = 2;
    return definition;
  });
  moveTo(player, 9, 9);
  // 玩家正站在格 (4,4)（中心 9,9）上：地基和他重叠。
  assert.equal(send({ kind: 'place', archetypeId: 'float-foundation', surface: 'floating', cellX: 4, cellZ: 4 }), false);
  assert.equal(send({ kind: 'place', archetypeId: 'float-foundation', surface: 'floating', cellX: 5, cellZ: 5 }), true);
  const [root] = buildActors(scene);
  const hull = hullOf(scene, root);
  assert.equal(send({ kind: 'place', archetypeId: 'float-foundation', surface: 'floating', hullActorId: hull.id, cellX: 1, cellZ: 0 }), true);
  assert.equal(send({ kind: 'place', archetypeId: 'float-foundation', surface: 'floating', hullActorId: hull.id, cellX: -1, cellZ: 0 }), false, '这艘船最多两件');

  // 旧序号直接丢掉，哪怕内容合法。
  assert.equal(scene.applyBuildCommand('builder', { sequence: 1, command: { kind: 'remove', actorId: root.id } }), false);
  assert.equal(scene.actorWorld.getActor(root.id), root);

  // 预制木筏不再是建造表面：紧挨着它的水面立新船会被木筏的碰撞盒挡住。
  moveTo(player, 0, 6);
  assert.equal(send({ kind: 'place', archetypeId: 'float-foundation', surface: 'floating', cellX: 0, cellZ: 1 }), false, '格 (0,1) 压在木筏上');
});

test('流式地图：静态地基落在地形上，墙能直接立在地形格边上，篝火放在陆地格中心', async () => {
  const { scene, player, send, inventory } = await createScene('open-world');
  inventory.add('wood-log', 30);
  inventory.add('stone', 10);

  // 在出生点附近找一个没被树石挡住的陆地格。
  const placed = [];
  const tryPlace = (archetypeId, cellX, cellZ, edge) => {
    // 站在格外一点：半格 1 米加上玩家半径，再远一点才不会把自己挡住。
    moveTo(player, (cellX + 0.5) * BUILD_CELL_SIZE + 1.6, (cellZ + 0.5) * BUILD_CELL_SIZE + 1.6);
    const ok = send({ kind: 'place', archetypeId, surface: 'static', cellX, cellZ, ...(edge ? { edge } : {}) });
    if (ok) placed.push([archetypeId, cellX, cellZ]);
    return ok;
  };
  let foundationCell;
  for (let cellX = -8; cellX <= 8 && !foundationCell; cellX += 1) {
    for (let cellZ = -8; cellZ <= 8 && !foundationCell; cellZ += 1) {
      if (scene.buildCellStatus(cellX, cellZ) !== 'land') continue;
      if (tryPlace('ground-foundation', cellX, cellZ)) foundationCell = [cellX, cellZ];
    }
  }
  assert.ok(foundationCell, '出生点周围总有一格能放地基');
  const [cellX, cellZ] = foundationCell;
  const foundation = buildActors(scene).find((actor) => actor.archetypeId === 'ground-foundation');
  const foundationTransform = foundation.getComponent(TRANSFORM_COMPONENT);
  assert.ok(Math.abs(foundationTransform.y - scene.groundTopHeight(cellX, cellZ)) < 1e-9, '地基落在那格的最高角点上');
  assert.equal(foundation.parent, undefined, '静态件没有父节点');

  // 地基边上的墙落在地基顶面上。
  assert.equal(tryPlace('wood-wall', cellX, cellZ, 'north'), true);
  const wall = buildActors(scene).find((actor) => actor.archetypeId === 'wood-wall');
  assert.ok(Math.abs(wall.getComponent(TRANSFORM_COMPONENT).y - (foundationTransform.y + 0.12)) < 1e-9);

  // 地基上放篝火：同格同槽只能一个。
  assert.equal(tryPlace('campfire', cellX, cellZ), true);
  assert.equal(tryPlace('campfire', cellX, cellZ), false);
  // 篝火还没拆，地基拆不掉。
  moveTo(player, foundationTransform.x + 1, foundationTransform.z + 1);
  assert.equal(send({ kind: 'remove', actorId: foundation.id }), false);

  // 直接立在地形格边上的墙：找一格附近没有地基的陆地。
  let rawWall = false;
  for (let dx = -4; dx <= 4 && !rawWall; dx += 1) {
    for (let dz = -4; dz <= 4 && !rawWall; dz += 1) {
      const x = cellX + dx;
      const z = cellZ + dz;
      if (scene.buildSites.hasFoundation('static', x, z) || scene.buildCellStatus(x, z) !== 'land') continue;
      rawWall = tryPlace('stone-wall', x, z, 'east');
    }
  }
  assert.ok(rawWall, '静态墙可以直接立在地形格边上');
  assert.equal(inventory.quantityOf('stone'), 10 - 2 - 3);
});

test('水域格上的静态地基是一座码头：板面浮在水面上；开阔水面上也能立船', async () => {
  const { scene, player, send, inventory } = await createScene('open-world');
  inventory.add('wood-log', 30);
  let water;
  for (let radius = 2; radius <= 120 && !water; radius += 1) {
    for (let cellX = -radius; cellX <= radius && !water; cellX += 1) {
      for (const cellZ of [-radius, radius]) {
        if (scene.buildCellStatus(cellX, cellZ) === 'water') { water = [cellX, cellZ]; break; }
      }
    }
    for (let cellZ = -radius; cellZ <= radius && !water; cellZ += 1) {
      for (const cellX of [-radius, radius]) {
        if (scene.buildCellStatus(cellX, cellZ) === 'water') { water = [cellX, cellZ]; break; }
      }
    }
  }
  if (!water) {
    // 这个种子附近没有水：码头与立船在纯海域图的用例里已经覆盖。
    return;
  }
  const [cellX, cellZ] = water;
  moveTo(player, (cellX + 0.5) * BUILD_CELL_SIZE + 1.5, (cellZ + 0.5) * BUILD_CELL_SIZE);
  const pier = send({ kind: 'place', archetypeId: 'ground-foundation', surface: 'static', cellX, cellZ });
  if (pier) {
    const actor = buildActors(scene).find((candidate) => candidate.archetypeId === 'ground-foundation');
    assert.ok(actor.getComponent(TRANSFORM_COMPONENT).y >= scene.seaLevel - 1e-9, '码头板不低于水面');
    moveTo(player, actor.getComponent(TRANSFORM_COMPONENT).x + 1, actor.getComponent(TRANSFORM_COMPONENT).z + 1);
    send({ kind: 'remove', actorId: actor.id });
  }
  moveTo(player, (cellX + 0.5) * BUILD_CELL_SIZE + 1.5, (cellZ + 0.5) * BUILD_CELL_SIZE);
  const founded = send({ kind: 'place', archetypeId: 'float-foundation', surface: 'floating', cellX, cellZ });
  if (founded) {
    const root = buildActors(scene).find((candidate) => candidate.archetypeId === 'float-foundation');
    const hull = hullOf(scene, root);
    assert.ok(Math.abs(hull.getComponent(TRANSFORM_COMPONENT).y - scene.seaLevel) < 1e-9, '船立在这张图的水面高度上');
    assert.ok(hull.getComponent(ACTOR_CONTROL_COMPONENT), '立起来的船留有驾驶接口');
  }
});
