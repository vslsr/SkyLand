import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginMainFrame,
  endMainFrame,
  mainFrameIntervalMs,
  recordReconciliation,
  reportMainThreadPacing,
  resetMainThreadPacing,
} from '../src/debug/mainThreadPacing';

/**
 * 主线程的节拍账：丢拍、画过头、和解拉回。
 *
 * 各阶段耗时看不见回调之间的空洞，这里补的正是那一块。时间戳全按 60Hz 的一拍
 * 16.667ms 手拨，画过头那条靠 `performance.now()`，用真时钟里「回调结束时已经
 * 过了下一拍」这一条界定，测试里把 now 往回拨来制造。
 */

const STEP = 1000 / 60;

test('相邻 rAF 差一拍不算丢拍；差两拍算一次，记最长间隔', () => {
  resetMainThreadPacing();
  let now = 0;
  for (let frame = 0; frame < 10; frame += 1) { beginMainFrame(now); now += STEP; }
  assert.ok(Math.abs(mainFrameIntervalMs() - STEP) < 1e-9, '一拍估成 16.67ms');
  // 丢一拍：下一次时间戳隔了两拍。
  now += STEP;
  beginMainFrame(now);
  const report = reportMainThreadPacing();
  assert.equal(report.frames, 11);
  assert.equal(report.droppedFrames, 1);
  assert.ok(Math.abs(report.longestGapMs - 2 * STEP) < 1e-9);
  // 报完清零。
  assert.equal(reportMainThreadPacing().droppedFrames, 0);
});

test('切标签页回来隔了很久：算一次丢拍，但不把一拍估成几秒', () => {
  resetMainThreadPacing();
  let now = 0;
  for (let frame = 0; frame < 9; frame += 1) { beginMainFrame(now); now += STEP; }
  beginMainFrame(now + 5000);
  assert.ok(Math.abs(mainFrameIntervalMs() - STEP) < 1e-9);
  assert.equal(reportMainThreadPacing().droppedFrames, 1);
});

test('回调结束已经过了下一个 vsync 算画过头', () => {
  resetMainThreadPacing();
  const realNow = performance.now();
  // 假装这一拍的 vsync 在 40ms 之前：回调「现在」才结束，早就过了下一拍。
  beginMainFrame(realNow - 40);
  endMainFrame(realNow - 40);
  const late = reportMainThreadPacing();
  assert.equal(late.overrunFrames, 1);
  assert.ok(late.worstOverrunMs > 20);
  // 正常的一帧：vsync 就在刚才，没过头。
  beginMainFrame(performance.now());
  endMainFrame(performance.now());
  assert.equal(reportMainThreadPacing().overrunFrames, 0);
});

test('和解：只有 corrected 算拉回，残差取最大，瞬移单独数', () => {
  resetMainThreadPacing();
  recordReconciliation({ corrected: false, residualDistance: 0.02 });
  recordReconciliation({ corrected: true, residualDistance: 0.12 });
  recordReconciliation({ corrected: true, snapped: true, residualDistance: 3.4 });
  const report = reportMainThreadPacing();
  assert.equal(report.corrections, 2);
  assert.equal(report.snaps, 1);
  assert.equal(report.worstResidualMeters, 3.4);
  assert.equal(reportMainThreadPacing().corrections, 0, '报完清零');
});
