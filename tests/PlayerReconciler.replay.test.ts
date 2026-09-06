import assert from 'node:assert/strict';
import test from 'node:test';
import { getRapier, PhysicsWorld } from '../shared/physics/index.mjs';
import { copyCharacterState, createCharacterState } from '../shared/physics/characterState.mjs';
import { createCharacterSimulationParams, stepCharacter } from '../shared/physics/stepCharacter.mjs';
import { SIMULATION_STEP_SECONDS } from '../shared/networkTuning.mjs';
import { PlayerReconciler, type ReconcilerTarget } from '../src/player/PlayerReconciler.ts';
import type { PlayerInputStep } from '../src/network/protocol.ts';

test('零延迟权威状态重放未确认步后与原预测逐位相同', () => {
  const physics = new PhysicsWorld(getRapier(), { timestep: SIMULATION_STEP_SECONDS });
  physics.setActorCollider('ground', {
    shape: 'box', x: 0, y: 0, z: 0, yaw: 0,
    halfWidth: 20, halfLength: 20, minimumY: -1, maximumY: 0,
  });
  physics.createCharacter('player', { x: 0, y: 0, z: 0, radius: 0.42, halfHeight: 0.42 });
  physics.prepareQueries();
  const state = createCharacterState({ grounded: true });
  const params = createCharacterSimulationParams(
    'player',
    { walkSpeed: 4, sprintMultiplier: 1.5, acceleration: 28, deceleration: 24, airAcceleration: 8 },
    { impulse: 7, gravity: 22, maximumFallSpeed: 20, airControl: 0.85 },
  );
  const inputs: PlayerInputStep[] = Array.from({ length: 9 }, (_, index) => ({
    tick: index + 1,
    move: { x: index < 6 ? 1 : 0, z: index < 6 ? 0 : 1 },
    sprint: index >= 4,
    jump: index === 2,
    yaw: 0,
  }));
  let authorityAtThree = createCharacterState();
  for (const input of inputs) {
    stepCharacter(state, input, SIMULATION_STEP_SECONDS, physics, params);
    if (input.tick === 3) authorityAtThree = createCharacterState(state);
  }
  const predicted = createCharacterState(state);
  const target: ReconcilerTarget = {
    rewindAndReplay(authoritative, pending) {
      copyCharacterState(state, authoritative);
      physics.setCharacterTranslation('player', state);
      physics.prepareQueries();
      for (const input of pending) {
        stepCharacter(state, input, SIMULATION_STEP_SECONDS, physics, params);
      }
      return { replayed: pending.length, residualDistance: 0, corrected: false, snapped: false };
    },
  };
  const reconciler = new PlayerReconciler();
  reconciler.acceptAuthoritative(3, authorityAtThree, inputs, target);
  for (const key of ['x', 'y', 'z', 'vx', 'vy', 'vz'] as const) {
    assert.ok(Math.abs(state[key] - predicted[key]) < 1e-9, `${key} diverged`);
  }
  assert.equal(state.grounded, predicted.grounded);
  physics.dispose();
});

test('按住跳跃键时，每份快照的和解都不能让预测重新起跳', () => {
  // 按住空格「一直位于空中」的回归用例。跳跃是边沿触发的——`stepCharacter` 只在
  // 「这一步按下、上一步没按下」时起跳——所以 `jumpPressed` 和坐标、速度一样是
  // 权威状态的一部分。快照少带这一位，重放就会从「上一步没按」重新起算，落地那
  // 一刻立刻又被顶上去，人再也落不下来。
  const LATENCY_STEPS = 5;
  const SNAPSHOT_EVERY_STEPS = 3;
  const TOTAL_STEPS = 300;

  function createWorld(): PhysicsWorld {
    const physics = new PhysicsWorld(getRapier(), { timestep: SIMULATION_STEP_SECONDS });
    physics.setActorCollider('ground', {
      shape: 'box', x: 0, y: 0, z: 0, yaw: 0,
      halfWidth: 40, halfLength: 40, minimumY: -1, maximumY: 0,
    });
    physics.createCharacter('player', { x: 0, y: 0, z: 0, radius: 0.42, halfHeight: 0.42 });
    physics.prepareQueries();
    return physics;
  }

  const createParams = () => createCharacterSimulationParams(
    'player',
    { walkSpeed: 4, sprintMultiplier: 1.5, acceleration: 28, deceleration: 24, airAcceleration: 8 },
    { impulse: 7, gravity: 22, maximumFallSpeed: 20, airControl: 0.85 },
  );

  const server = createWorld();
  const serverParams = createParams();
  const serverState = createCharacterState({ grounded: true });
  const client = createWorld();
  const clientParams = createParams();
  const clientState = createCharacterState({ grounded: true });

  const pending: PlayerInputStep[] = [];
  const reconciler = new PlayerReconciler();
  const target: ReconcilerTarget = {
    rewindAndReplay(authoritative, replayed) {
      copyCharacterState(clientState, authoritative);
      client.setCharacterTranslation('player', clientState);
      client.prepareQueries();
      for (const input of replayed) {
        stepCharacter(clientState, input, SIMULATION_STEP_SECONDS, client, clientParams);
      }
      return { replayed: replayed.length, residualDistance: 0, corrected: false, snapped: false };
    },
  };

  let serverAirborneSteps = 0;
  let clientAirborneSteps = 0;
  let ackTick = 0;
  for (let tick = 1; tick <= TOTAL_STEPS; tick += 1) {
    // 空格从头按到尾，方向键也一直按着：上行的每一步都带 jump: true。
    const input: PlayerInputStep = {
      tick, move: { x: 1, z: 0 }, sprint: false, jump: true, yaw: 0,
    };
    stepCharacter(clientState, input, SIMULATION_STEP_SECONDS, client, clientParams);
    if (!clientState.grounded) clientAirborneSteps += 1;
    pending.push(input);

    const acknowledged = pending.find((step) => step.tick === tick - LATENCY_STEPS);
    if (acknowledged) {
      stepCharacter(serverState, acknowledged, SIMULATION_STEP_SECONDS, server, serverParams);
      if (!serverState.grounded) serverAirborneSteps += 1;
      ackTick = acknowledged.tick;
    }
    if (ackTick > 0 && tick % SNAPSHOT_EVERY_STEPS === 0) {
      // 和 `PlayerEntity.applyAuthoritativeState` 交给 Reconciler 的那一份同形。
      reconciler.acceptAuthoritative(ackTick, {
        x: serverState.x,
        y: serverState.y,
        z: serverState.z,
        vx: serverState.vx,
        vy: serverState.vy,
        vz: serverState.vz,
        grounded: serverState.grounded,
        jumpPressed: serverState.jumpPressed,
      }, pending, target);
      const firstPending = pending.findIndex((step) => step.tick > ackTick);
      pending.splice(0, firstPending < 0 ? pending.length : firstPending);
    }
  }

  assert.ok(
    serverAirborneSteps > 0 && serverAirborneSteps < TOTAL_STEPS / 2,
    `权威只该跳一次：腾空 ${serverAirborneSteps} 步`,
  );
  assert.ok(
    clientAirborneSteps <= serverAirborneSteps + SNAPSHOT_EVERY_STEPS,
    `按住空格时预测被和解反复顶起来：预测腾空 ${clientAirborneSteps} 步，权威只有 ${serverAirborneSteps} 步`,
  );
  assert.equal(clientState.grounded, true, '按住不放的那只手不该让人一直悬在空中');
  server.dispose();
  client.dispose();
});
