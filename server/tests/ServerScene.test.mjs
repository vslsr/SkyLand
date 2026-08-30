import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerScene } from '../scene/ServerScene.mjs';
import {
  PLAYER_BOUNDS,
  PLAYER_MAXIMUM_SPEED,
  PLAYER_MOVE_SPEED,
  createSpawnPoint,
} from '../../shared/playerMovement.mjs';
import { INPUT_TIME_BUDGET_SECONDS, MAXIMUM_INPUT_DELTA_SECONDS } from '../../shared/networkTuning.mjs';

/** 可控时钟，用来断言与真实时间相关的校验。 */
function createClock(startAt = 1_000_000) {
  let current = startAt;
  return {
    now: () => current,
    advance(seconds) {
      current += seconds * 1000;
    },
  };
}

test('ServerScene 依据输入推进玩家并在离开后清理', () => {
  const scene = new ServerScene('grassland');
  scene.addPlayer({ id: 'player-1', name: '旅人', slot: 0 });
  const spawn = createSpawnPoint(0);

  scene.applyInput('player-1', {
    sequence: 1,
    deltaSeconds: 0.05,
    move: { x: 1, z: 0 },
    sprint: false,
    yaw: 0.5,
  });

  const snapshot = scene.createSnapshot();
  assert.equal(snapshot.players.length, 1);
  assert.equal(snapshot.players[0].sequence, 1);
  assert.ok(Math.abs(snapshot.players[0].x - (spawn.x + PLAYER_MOVE_SPEED * 0.05)) < 0.001);
  assert.ok(Math.abs(snapshot.players[0].yaw - 0.5) < 0.001);

  scene.removePlayer('player-1');
  assert.equal(scene.createSnapshot().players.length, 0);
});

test('同一房间的玩家按座位号分散出生', () => {
  const scene = new ServerScene('grassland');
  scene.addPlayer({ id: 'a', name: 'A', slot: 0 });
  scene.addPlayer({ id: 'b', name: 'B', slot: 1 });

  const [first, second] = scene.createSnapshot().players;
  assert.ok(Math.hypot(first.x - second.x, first.z - second.z) > 0.5);
});

test('重放或乱序到达的旧输入被丢弃', () => {
  const scene = new ServerScene('grassland');
  scene.addPlayer({ id: 'player-1', name: '旅人', slot: 0 });

  scene.applyInput('player-1', { sequence: 5, deltaSeconds: 0.05, move: { x: 1, z: 0 } });
  const afterFirst = scene.createSnapshot().players[0].x;

  scene.applyInput('player-1', { sequence: 5, deltaSeconds: 0.05, move: { x: 1, z: 0 } });
  scene.applyInput('player-1', { sequence: 2, deltaSeconds: 0.05, move: { x: 1, z: 0 } });

  assert.equal(scene.createSnapshot().players[0].x, afterFirst);
});

test('放大方向向量无法提高速度', () => {
  const clock = createClock();
  const scene = new ServerScene('grassland', { now: clock.now });
  scene.addPlayer({ id: 'honest', name: '诚实', slot: 0 });
  scene.addPlayer({ id: 'cheater', name: '作弊', slot: 0 });

  scene.applyInput('honest', { sequence: 1, deltaSeconds: 0.05, move: { x: 1, z: 0 } });
  scene.applyInput('cheater', { sequence: 1, deltaSeconds: 0.05, move: { x: 999, z: 0 } });

  const players = new Map(scene.createSnapshot().players.map((player) => [player.id, player]));
  assert.equal(players.get('cheater').x, players.get('honest').x);
});

test('单条输入的模拟时间被钳制在上限内', () => {
  const clock = createClock();
  const scene = new ServerScene('grassland', { now: clock.now });
  scene.addPlayer({ id: 'cheater', name: '作弊', slot: 0 });
  const spawn = createSpawnPoint(0);

  scene.applyInput('cheater', { sequence: 1, deltaSeconds: 60, move: { x: 1, z: 0 }, sprint: true });

  const moved = scene.createSnapshot().players[0].x - spawn.x;
  assert.ok(moved <= PLAYER_MAXIMUM_SPEED * MAXIMUM_INPUT_DELTA_SECONDS + 0.001);
});

test('时间预算限制了不推进时钟时能走出的总距离', () => {
  const clock = createClock();
  const scene = new ServerScene('grassland', { now: clock.now });
  scene.addPlayer({ id: 'cheater', name: '作弊', slot: 0 });
  const spawn = createSpawnPoint(0);

  // 时钟完全不前进，但连续灌入 100 条满额输入。
  for (let sequence = 1; sequence <= 100; sequence += 1) {
    scene.applyInput('cheater', {
      sequence,
      deltaSeconds: MAXIMUM_INPUT_DELTA_SECONDS,
      move: { x: 1, z: 0 },
      sprint: true,
    });
  }

  const moved = scene.createSnapshot().players[0].x - spawn.x;
  assert.ok(moved <= PLAYER_MAXIMUM_SPEED * INPUT_TIME_BUDGET_SECONDS + 0.001);

  // 时钟走过之后预算重新补满，正常玩家不受影响。
  clock.advance(INPUT_TIME_BUDGET_SECONDS);
  scene.update();
  scene.applyInput('cheater', { sequence: 200, deltaSeconds: 0.05, move: { x: 1, z: 0 } });
  assert.ok(scene.createSnapshot().players[0].x - spawn.x > moved);
});

test('玩家无法走出世界边界', () => {
  const clock = createClock();
  const scene = new ServerScene('grassland', { now: clock.now });
  scene.addPlayer({ id: 'player-1', name: '旅人', slot: 0 });

  // 直接放到边界附近，再一路往外冲。
  const player = scene.players.get('player-1');
  player.x = PLAYER_BOUNDS.maximumX - 1;
  player.z = PLAYER_BOUNDS.maximumZ - 1;

  for (let sequence = 1; sequence <= 200; sequence += 1) {
    clock.advance(0.05);
    scene.update();
    scene.applyInput('player-1', {
      sequence,
      deltaSeconds: 0.05,
      move: { x: 1, z: 1 },
      sprint: true,
    });
  }

  const snapshot = scene.createSnapshot().players[0];
  assert.equal(snapshot.x, PLAYER_BOUNDS.maximumX);
  assert.equal(snapshot.z, PLAYER_BOUNDS.maximumZ);
});

test('非法数值不会污染权威状态', () => {
  const scene = new ServerScene('grassland');
  scene.addPlayer({ id: 'player-1', name: '旅人', slot: 0 });

  scene.applyInput('player-1', {
    sequence: 1,
    deltaSeconds: Number.NaN,
    move: { x: Number.POSITIVE_INFINITY, z: 'abc' },
    yaw: Number.NaN,
  });

  const player = scene.createSnapshot().players[0];
  assert.ok(Number.isFinite(player.x));
  assert.ok(Number.isFinite(player.z));
  assert.ok(Number.isFinite(player.yaw));
});
