import './initRapier.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SceneCatalog } from '../scenes/SceneCatalog.mjs';
import { ServerScene } from '../scene/ServerScene.mjs';
import { toChunkKey, toChunkCoordinate } from '../../shared/world/chunkKey.mjs';
import { WORLD_PLAY_AREA } from '../../shared/world/worldConfig.mjs';

/**
 * 大世界不再有一张 384 米见方的地图边框：玩家一直朝一个方向走，地块就一直
 * 按种子生成，而常驻集合始终只有他周围那几圈。两件事必须同时成立——只做到
 * 前者是内存泄漏，只做到后者是原地打转。
 */

/** 流式场景过去写死的活动半径，现在只是路上的一个坐标。 */
const RETIRED_SCENE_BOUND = 192;

function inputSteps(firstTick, count, move) {
  return {
    inputs: Array.from({ length: count }, (_, index) => ({
      tick: firstTick + index,
      move,
      sprint: true,
      jump: false,
      yaw: 0,
    })),
  };
}

test('玩家能一路走出老边界，常驻 chunk 数量不随里程增长', async () => {
  const catalog = await SceneCatalog.load();
  const definition = catalog.require('open-world');
  // 无边世界的场景不再写 bounds，活动范围就是整个世界。
  assert.deepEqual(definition.gameplay.bounds, WORLD_PLAY_AREA);

  let now = 1_000_000;
  const scene = new ServerScene(definition, { now: () => now });
  scene.addPlayer({ id: 'player-1', name: '远行者', slot: 0 });
  const player = scene.players.get('player-1');

  const residentCounts = new Set();
  let tick = 1;
  let lastDistance = 0;
  let blocked = 0;
  for (let packet = 1; packet <= 2_000; packet += 1) {
    now += 50;
    scene.update();
    // 一直朝西走，撞上台地或水岸就交替横切一下绕开：地形挡路是玩法，
    // 这条用例要断言的是「除了地形没有别的东西拦着」。
    if (packet % 20 === 0) {
      const distance = Math.hypot(player.x, player.z);
      blocked = distance - lastDistance < 0.4 ? blocked + 1 : 0;
      lastDistance = distance;
    }
    const drift = blocked > 0 ? (blocked % 2 === 0 ? 1 : -1) : 0;
    const length = Math.hypot(1, drift);
    scene.applyInput('player-1', inputSteps(tick, 3, { x: -1 / length, z: drift / length }));
    tick += 3;
    if (packet % 200 === 0) residentCounts.add(scene.chunkColliders.residentCount);
  }

  assert.ok(
    player.x < -(RETIRED_SCENE_BOUND + 48),
    `玩家只走到 ${player.x.toFixed(1)} 米，没有越过老边界`,
  );
  assert.ok(player.x > WORLD_PLAY_AREA.minimumX);
  // 走出去几百米之后仍然踩在有内容的地上：chunk 是跟着人生成的。
  assert.ok(scene.chunkColliders.residency.has(
    toChunkKey(toChunkCoordinate(player.x), toChunkCoordinate(player.z)),
  ));

  // 常驻集合的上界只由保留半径决定，和跑了多远无关。
  const keepSpan = scene.chunkColliders.keepRadius * 2 + 1;
  assert.ok(residentCounts.size > 0);
  for (const count of residentCounts) assert.ok(count <= keepSpan * keepSpan);

  scene.removePlayer('player-1');
});
