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
