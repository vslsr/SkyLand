import assert from 'node:assert/strict';
import test from 'node:test';
import { PlayerReconciler, type ReconcilerTarget } from '../src/player/PlayerReconciler.ts';
import type { PlayerInputStep } from '../src/network/protocol.ts';

const authoritative = {
  x: 1,
  y: 0.5,
  z: 2,
  vx: 3,
  vy: -1,
  vz: 0,
  grounded: false,
};

test('rewind & replay 只把 ack 之后的输入交给控制器', () => {
  const calls: Array<{ ticks: number[] }> = [];
  const target: ReconcilerTarget = {
    rewindAndReplay(_state, pending) {
      calls.push({ ticks: pending.map((input) => input.tick) });
      return { replayed: pending.length, residualDistance: 0, snapped: false };
    },
  };
  const inputs: PlayerInputStep[] = Array.from({ length: 5 }, (_, index) => ({
    tick: index + 1,
    move: { x: 1, z: 0 },
    sprint: false,
    jump: false,
    yaw: 0,
  }));
  const reconciler = new PlayerReconciler();
  assert.equal(reconciler.acceptAuthoritative(3, authoritative, inputs, target), true);
  assert.deepEqual(calls, [{ ticks: [4, 5] }]);
});

test('重复与倒序 ack 幂等，不会再次改写物理状态', () => {
  let calls = 0;
  const target: ReconcilerTarget = {
    rewindAndReplay() {
      calls += 1;
      return { replayed: 0, residualDistance: 0, snapped: false };
    },
  };
  const reconciler = new PlayerReconciler();
  assert.equal(reconciler.acceptAuthoritative(8, authoritative, [], target), true);
  assert.equal(reconciler.acceptAuthoritative(8, authoritative, [], target), false);
  assert.equal(reconciler.acceptAuthoritative(7, authoritative, [], target), false);
  assert.equal(calls, 1);
});
