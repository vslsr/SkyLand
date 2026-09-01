import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerScene } from '../scene/ServerScene.mjs';
import {
  PLAYER_BOUNDS,
  PLAYER_MAXIMUM_SPEED,
  PLAYER_MOVE_SPEED,
  createSpawnPoint,
} from '../../shared/playerMovement.mjs';
import {
  INPUT_TIME_BUDGET_SECONDS,
  MAXIMUM_INPUT_STEPS_PER_PACKET,
  SIMULATION_STEP_SECONDS,
} from '../../shared/networkTuning.mjs';

function inputSteps(firstTick, count, values = {}) {
  return {
    inputs: Array.from({ length: count }, (_, index) => ({
      tick: firstTick + index,
      move: values.move ?? { x: 0, z: 0 },
      sprint: values.sprint === true,
      jump: values.jump === true,
      yaw: values.yaw ?? 0,
    })),
  };
}

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

  scene.applyInput('player-1', inputSteps(1, 3, { move: { x: 1, z: 0 }, yaw: 0.5 }));

  const snapshot = scene.createSnapshot();
  assert.equal(snapshot.players.length, 1);
  assert.equal(snapshot.players[0].ackTick, 3);
  assert.equal(snapshot.players[0].sequence, 3);
  assert.ok(snapshot.players[0].x > spawn.x);
  assert.ok(snapshot.players[0].x <= spawn.x + PLAYER_MOVE_SPEED * 0.05 + 0.001);
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

  scene.applyInput('player-1', inputSteps(5, 1, { move: { x: 1, z: 0 } }));
  const afterFirst = scene.createSnapshot().players[0].x;

  scene.applyInput('player-1', inputSteps(5, 1, { move: { x: 1, z: 0 } }));
  scene.applyInput('player-1', inputSteps(2, 1, { move: { x: 1, z: 0 } }));

  assert.equal(scene.createSnapshot().players[0].x, afterFirst);
});

test('放大方向向量无法提高速度', () => {
  const clock = createClock();
  const scene = new ServerScene('grassland', { now: clock.now });
  scene.addPlayer({ id: 'honest', name: '诚实', slot: 0 });
  scene.addPlayer({ id: 'cheater', name: '作弊', slot: 0 });

  scene.applyInput('honest', inputSteps(1, 3, { move: { x: 1, z: 0 } }));
  scene.applyInput('cheater', inputSteps(1, 3, { move: { x: 999, z: 0 } }));

  const players = new Map(scene.createSnapshot().players.map((player) => [player.id, player]));
  assert.equal(players.get('cheater').x, players.get('honest').x);
});

test('单包输入步数被钳制在上限内', () => {
  const clock = createClock();
  const scene = new ServerScene('grassland', { now: clock.now });
  scene.addPlayer({ id: 'cheater', name: '作弊', slot: 0 });
  const spawn = createSpawnPoint(0);

  scene.applyInput('cheater', inputSteps(1, 100, { move: { x: 1, z: 0 }, sprint: true }));

  const moved = scene.createSnapshot().players[0].x - spawn.x;
  assert.ok(
    moved <= PLAYER_MAXIMUM_SPEED * MAXIMUM_INPUT_STEPS_PER_PACKET * SIMULATION_STEP_SECONDS + 0.001,
  );
  assert.equal(scene.createSnapshot().players[0].ackTick, MAXIMUM_INPUT_STEPS_PER_PACKET);
});

test('时间预算限制了不推进时钟时能走出的总距离', () => {
  const clock = createClock();
  const scene = new ServerScene('grassland', { now: clock.now });
  scene.addPlayer({ id: 'cheater', name: '作弊', slot: 0 });
  const spawn = createSpawnPoint(0);

  // 时钟完全不前进，但连续灌入 100 条满额输入。
  for (let tick = 1; tick <= 100; tick += MAXIMUM_INPUT_STEPS_PER_PACKET) {
    scene.applyInput('cheater', inputSteps(
      tick,
      MAXIMUM_INPUT_STEPS_PER_PACKET,
      { move: { x: 1, z: 0 }, sprint: true },
    ));
  }

  const moved = scene.createSnapshot().players[0].x - spawn.x;
  assert.ok(moved <= PLAYER_MAXIMUM_SPEED * INPUT_TIME_BUDGET_SECONDS + 0.001);

  // 时钟走过之后预算重新补满，正常玩家不受影响。
  clock.advance(INPUT_TIME_BUDGET_SECONDS);
  scene.update();
  scene.applyInput('cheater', inputSteps(200, 3, { move: { x: 1, z: 0 } }));
  assert.ok(scene.createSnapshot().players[0].x - spawn.x > moved);
});

test('玩家无法走出玩法平面的活动范围', () => {
  const clock = createClock();
  const scene = new ServerScene('grassland', { now: clock.now });
  scene.addPlayer({ id: 'player-1', name: '旅人', slot: 0 });

  let tick = 1;
  for (let packet = 1; packet <= 400; packet += 1) {
    clock.advance(0.05);
    scene.update();
    scene.applyInput('player-1', inputSteps(tick, 3, { move: { x: 1, z: 1 }, sprint: true }));
    tick += 3;
  }

  const player = scene.createSnapshot().players[0];
  assert.ok(player.x <= PLAYER_BOUNDS.maximumX);
  assert.ok(player.z <= PLAYER_BOUNDS.maximumZ);
});

test('非法数值不会污染权威状态', () => {
  const scene = new ServerScene('grassland');
  scene.addPlayer({ id: 'player-1', name: '旅人', slot: 0 });

  scene.applyInput('player-1', inputSteps(1, 1, {
    move: { x: Number.POSITIVE_INFINITY, z: 'abc' },
    yaw: Number.NaN,
  }));

  const player = scene.createSnapshot().players[0];
  assert.ok(Number.isFinite(player.x));
  assert.ok(Number.isFinite(player.z));
  assert.ok(Number.isFinite(player.yaw));
});

test('玩家 Transform 诊断记录输入接收、固定步推进和包完成状态', () => {
  const events = [];
  const scene = new ServerScene('grassland', {
    playerTransformDebug: {
      isEnabled: (playerId) => playerId === 'player-1',
      record: (event) => events.push(event),
    },
  });
  scene.addPlayer({ id: 'player-1', name: '旅人', slot: 0 });

  scene.applyInput('player-1', inputSteps(1, 2, { move: { x: 1, z: 0 } }));

  assert.deepEqual(events.map((event) => event.event), [
    'server.input_packet_received',
    'server.input_step_applied',
    'server.input_step_applied',
    'server.input_packet_completed',
  ]);
  assert.equal(events[1].data.before.ackTick, 0);
  assert.equal(events[1].data.after.ackTick, 1);
  assert.equal(events[2].data.after.ackTick, 2);
  assert.ok(events[2].data.after.transform.x > events[1].data.after.transform.x);
});

test('房间权威跳跃同步 Y，空中仍按 airControl 接受方向输入并最终落地', () => {
  const clock = createClock();
  const scene = new ServerScene('grassland', { now: clock.now });
  scene.addPlayer({ id: 'jump-player', name: '弹跳史莱姆', slot: 0 });
  const before = scene.createSnapshot().players[0];

  scene.applyInput('jump-player', inputSteps(1, 3, {
    move: { x: 1, z: 0 },
    jump: true,
  }));
  const airborne = scene.createSnapshot().players[0];
  assert.equal(airborne.grounded, false);
  assert.ok(airborne.verticalVelocity > 0);
  assert.ok(airborne.y > before.y);
  assert.ok(airborne.x > before.x, '空中方向键仍应产生水平位移');
  assert.ok(
    airborne.x - before.x < PLAYER_MOVE_SPEED * 0.05,
    '空中水平位移应应用 Actor 配置的 airControl',
  );

  let jumpTick = 4;
  for (let packet = 0; packet < 30; packet += 1) {
    clock.advance(0.05);
    scene.update();
    scene.applyInput('jump-player', inputSteps(jumpTick, 3));
    jumpTick += 3;
    if (scene.createSnapshot().players[0].grounded) break;
  }
  const landed = scene.createSnapshot().players[0];
  assert.equal(landed.grounded, true);
  assert.equal(landed.verticalVelocity, 0);
  assert.ok(
    Math.abs(landed.y - before.y) < 0.025,
    `landed y mismatch: before=${before.y}, after=${landed.y}`,
  );
});

test('房间服务端校验天气枚举并通过快照同步当前天气', () => {
  const scene = new ServerScene('grassland');
  scene.addPlayer({ id: 'player-1', name: '旅人', slot: 0 });

  assert.equal(scene.createSnapshot().weather, 'sunny');
  assert.equal(scene.setWeather('missing-player', 'rain'), false);
  assert.equal(scene.setWeather('player-1', 'sandstorm'), false);
  assert.equal(scene.createSnapshot().weather, 'sunny');
  assert.equal(scene.setWeather('player-1', 'blizzard'), true);
  assert.equal(scene.createSnapshot().weather, 'blizzard');
});

test('场景 JSON 的边界与出生配置参与权威模拟', () => {
  const scene = new ServerScene({
    id: 'tiny-map',
    gameplay: {
      bounds: { minimumX: -2, maximumX: 2, minimumZ: -3, maximumZ: 3 },
      spawn: { centerX: 1, centerZ: 1, radius: 0, slots: 2 },
    },
  });
  scene.addPlayer({ id: 'player-1', name: '旅人', slot: 0 });
  assert.deepEqual(
    { x: scene.createSnapshot().players[0].x, z: scene.createSnapshot().players[0].z },
    { x: 1, z: 1 },
  );

  scene.applyInput('player-1', inputSteps(1, 6, { move: { x: 1, z: 1 }, sprint: true }));
  const player = scene.createSnapshot().players[0];
  assert.ok(player.x <= 2);
  assert.ok(player.z <= 3);
});
import './initRapier.mjs';
