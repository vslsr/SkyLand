import './initRapier.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAXIMUM_IDLE_CATCH_UP_STEPS,
  PlayerIdleSimulation,
} from '../scene/PlayerIdleSimulation.mjs';
import { ServerScene } from '../scene/ServerScene.mjs';
import { SIMULATION_STEP_SECONDS } from '../../shared/networkTuning.mjs';
import { createCharacterState } from '../../shared/physics/characterState.mjs';

function createClock(startAt = 1_000_000) {
  let current = startAt;
  return {
    now: () => current,
    advance(seconds) {
      current += seconds * 1000;
    },
  };
}

function fakePlayer(state) {
  return {
    lastInputAt: 0,
    stepBudget: 15,
    idleStepAccumulator: 0,
    characterState: createCharacterState(state),
  };
}

test('静止且落地的玩家不会被补步', () => {
  const player = fakePlayer({ grounded: true });
  const idle = new PlayerIdleSimulation({ stepPlayer: () => assert.fail('不该补步') });
  assert.equal(idle.advance([player], 1, 10_000), 0);
});

test('输入还在的玩家不会被补步', () => {
  const player = fakePlayer({ grounded: false, vy: -5 });
  player.lastInputAt = 9_950;
  const idle = new PlayerIdleSimulation({ stepPlayer: () => assert.fail('不该补步') });
  assert.equal(idle.advance([player], 1, 10_000), 0);
});

test('静默的空中玩家按固定步补齐，且不超过单次上限', () => {
  const player = fakePlayer({ grounded: false, vy: -5 });
  let stepped = 0;
  const idle = new PlayerIdleSimulation({ stepPlayer: () => { stepped += 1; } });
  // 一整秒本该是 60 步，单个 tick 只允许补上限那么多。
  assert.equal(idle.advance([player], 1, 10_000), MAXIMUM_IDLE_CATCH_UP_STEPS);
  assert.equal(stepped, MAXIMUM_IDLE_CATCH_UP_STEPS);
  assert.ok(player.idleStepAccumulator < SIMULATION_STEP_SECONDS, '欠账没有被丢弃');
});

test('补步受 stepBudget 约束，预算耗尽就停', () => {
  const player = fakePlayer({ grounded: false, vy: -5 });
  player.stepBudget = 2;
  let stepped = 0;
  const idle = new PlayerIdleSimulation({
    stepPlayer: (target) => {
      stepped += 1;
      target.stepBudget -= 1;
    },
  });
  assert.equal(idle.advance([player], 1, 10_000), 2);
  assert.equal(stepped, 2);
});

test('收到输入后补步余量清零', () => {
  const player = fakePlayer({ grounded: false, vy: -5 });
  const idle = new PlayerIdleSimulation({ stepPlayer: () => {} });
  idle.advance([player], 0.01, 10_000);
  assert.ok(player.idleStepAccumulator > 0);
  idle.reset(player);
  assert.equal(player.idleStepAccumulator, 0);
});

test('客户端停止上行后玩家仍然会落地，而不是停在半空', () => {
  const clock = createClock();
  const scene = new ServerScene('grassland', { now: clock.now });
  scene.addPlayer({ id: 'faller', name: '掉线的人', slot: 0 });
  const player = scene.players.get('faller');
  const groundY = player.y;

  scene.applyInput('faller', {
    inputs: [{ tick: 1, move: { x: 0, z: 0 }, jump: true, yaw: 0 }],
  });
  assert.equal(player.characterState.grounded, false);
  assert.ok(player.characterState.vy > 0, '起跳没有产生向上速度');

  // 之后一条输入都不再上行：房间只推进自己的 tick。
  for (let tick = 0; tick < 80; tick += 1) {
    clock.advance(1 / 20);
    scene.update();
  }

  assert.equal(player.characterState.grounded, true, '玩家停在了半空');
  assert.ok(Math.abs(player.y - groundY) < 0.05, `没有落回地面：${player.y} vs ${groundY}`);
  assert.equal(player.ackTick, 1, '补步不应该顶掉客户端的输入确认');
});

test('站着不动的玩家静默时不消耗预算', () => {
  const clock = createClock();
  const scene = new ServerScene('grassland', { now: clock.now });
  scene.addPlayer({ id: 'afk', name: '挂机', slot: 0 });
  const player = scene.players.get('afk');
  scene.applyInput('afk', { inputs: [{ tick: 1, move: { x: 0, z: 0 }, yaw: 0 }] });
  for (let tick = 0; tick < 40; tick += 1) {
    clock.advance(1 / 20);
    scene.update();
  }
  assert.equal(player.stepBudget, Math.floor(0.25 / SIMULATION_STEP_SECONDS));
  assert.equal(player.ackTick, 1);
});
