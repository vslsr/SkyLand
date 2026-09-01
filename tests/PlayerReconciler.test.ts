import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayerReconciler, type ReconcilerTarget } from '../src/player/PlayerReconciler.ts';
import { PLAYER_BOUNDS, clampToRange } from '../shared/playerMovement.mjs';
import { RECONCILE_SNAP_DISTANCE, RECONCILE_TOLERANCE } from '../shared/networkTuning.mjs';

/** 只保留位置的假控制器，替代依赖 DOM 与 Three.js 的 TopDownController。 */
function createTarget(x = 0, z = 0): ReconcilerTarget {
  const state = { x, z };
  return {
    get position() {
      return state;
    },
    setPosition(nextX: number, nextZ: number) {
      state.x = clampToRange(nextX, PLAYER_BOUNDS.minimumX, PLAYER_BOUNDS.maximumX);
      state.z = clampToRange(nextZ, PLAYER_BOUNDS.minimumZ, PLAYER_BOUNDS.maximumZ);
    },
    translate(deltaX: number, deltaZ: number) {
      this.setPosition(state.x + deltaX, state.z + deltaZ);
    },
  };
}

function settle(reconciler: PlayerReconciler, target: ReconcilerTarget, frames = 120): void {
  for (let frame = 0; frame < frames; frame += 1) reconciler.update(1 / 60, target);
}

test('预测与服务器一致时不产生任何纠正', () => {
  const reconciler = new PlayerReconciler();
  const target = createTarget(2, 3);
  reconciler.recordPrediction(1, 2, 3);
  reconciler.acceptAuthoritative(1, 2, 3, target);
  settle(reconciler, target);

  assert.equal(target.position.x, 2);
  assert.equal(target.position.z, 3);
});

test('容差以内的误差被忽略', () => {
  const reconciler = new PlayerReconciler();
  const target = createTarget(2, 0);
  reconciler.recordPrediction(1, 2, 0);
  reconciler.acceptAuthoritative(1, 2 + RECONCILE_TOLERANCE / 2, 0, target);
  settle(reconciler, target);

  assert.equal(target.position.x, 2);
});

test('正常范围内的误差被平滑地拉回而不是瞬移', () => {
  const reconciler = new PlayerReconciler();
  const target = createTarget(0, 0);
  reconciler.recordPrediction(1, 0, 0);
  reconciler.acceptAuthoritative(1, 0.5, 0, target);

  reconciler.update(1 / 60, target);
  assert.ok(target.position.x > 0 && target.position.x < 0.5, '第一帧只走完误差的一部分');

  settle(reconciler, target);
  assert.ok(Math.abs(target.position.x - 0.5) < 0.001, '最终收敛到服务器位置');
});

test('跳跃 Y 与水平位置使用同一输入序号平滑和解', () => {
  const reconciler = new PlayerReconciler();
  const state = { x: 0, y: 0.8, z: 0 };
  const target: ReconcilerTarget = {
    get position() { return state; },
    get verticalPosition() { return state.y; },
    setPosition(x, z) { state.x = x; state.z = z; },
    setVerticalPosition(y) { state.y = y; },
    translate(x, z) { state.x += x; state.z += z; },
    translateVertical(y) { state.y += y; },
  };
  reconciler.recordPrediction(1, 0, 0, 0.8);
  reconciler.acceptAuthoritative(1, 0.2, 0, target, 1.1);
  reconciler.update(1 / 60, target);
  assert.ok(state.x > 0 && state.x < 0.2);
  assert.ok(state.y > 0.8 && state.y < 1.1);
  settle(reconciler, target);
  assert.ok(Math.abs(state.x - 0.2) < 0.001);
  assert.ok(Math.abs(state.y - 1.1) < 0.001);
});

test('误差过大时直接瞬移到服务器位置', () => {
  const reconciler = new PlayerReconciler();
  const target = createTarget(0, 0);
  reconciler.recordPrediction(1, 0, 0);
  reconciler.acceptAuthoritative(1, RECONCILE_SNAP_DISTANCE + 1, 0, target);

  assert.equal(target.position.x, RECONCILE_SNAP_DISTANCE + 1);
});

test('纠正过程中继续预测不会把同一份误差算两次', () => {
  const reconciler = new PlayerReconciler();
  const target = createTarget(0, 0);

  // 客户端预测走到 1.0 并上报序号 1，服务器认为当时只到 0.6。
  target.translate(1, 0);
  reconciler.recordPrediction(1, target.position.x, target.position.z);
  reconciler.acceptAuthoritative(1, 0.6, 0, target);
  settle(reconciler, target, 30);

  // 纠正还没走完，客户端又预测前进 0.5 并上报序号 2。
  target.translate(0.5, 0);
  reconciler.recordPrediction(2, target.position.x, target.position.z);
  settle(reconciler, target, 30);

  // 服务器对序号 2 给出 0.6 + 0.5：增量一致，只差最初那次误差。
  reconciler.acceptAuthoritative(2, 1.1, 0, target);
  settle(reconciler, target);

  assert.ok(Math.abs(target.position.x - 1.1) < 0.01, `实际收敛到 ${target.position.x}`);
});

test('服务器确认之前发出的多条输入时只按最新的一条对账', () => {
  const reconciler = new PlayerReconciler();
  const target = createTarget(0, 0);

  for (let sequence = 1; sequence <= 5; sequence += 1) {
    target.translate(0.2, 0);
    reconciler.recordPrediction(sequence, target.position.x, target.position.z);
  }

  // 只确认到序号 3，对应的预测位置是 0.6，服务器给出同一个值。
  reconciler.acceptAuthoritative(3, 0.6, 0, target);
  settle(reconciler, target);

  assert.ok(Math.abs(target.position.x - 1) < 0.001, '尚未确认的两条输入依然保留在预测里');
});

test('纠正被活动范围截断时位置不会越界', () => {
  const reconciler = new PlayerReconciler();
  const target = createTarget(PLAYER_BOUNDS.maximumX, 0);
  reconciler.recordPrediction(1, PLAYER_BOUNDS.maximumX, 0);
  reconciler.acceptAuthoritative(1, PLAYER_BOUNDS.maximumX + 1, 0, target);
  settle(reconciler, target);

  assert.equal(target.position.x, PLAYER_BOUNDS.maximumX);
});
