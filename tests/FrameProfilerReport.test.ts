import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_PHASE_LIMIT,
  STALE_REPORT_MILLISECONDS,
  formatFrameProfiler,
} from '../src/debug/frameProfilerReport';
import { FrameTimeline, type FrameTimingReport } from '../src/platform/index';

function reportWith(phases: Record<string, number[]>, frameMilliseconds: number[]): FrameTimingReport {
  let current = 0;
  const timeline = new FrameTimeline({ now: () => current });
  const frames = Math.max(frameMilliseconds.length, ...Object.values(phases).map((v) => v.length));
  for (let frame = 0; frame < frames; frame += 1) {
    timeline.beginFrame();
    for (const [phase, samples] of Object.entries(phases)) {
      const cost = samples[frame];
      if (cost === undefined) continue;
      timeline.measure(phase, () => { current += cost; });
    }
    current += Math.max(0, (frameMilliseconds[frame] ?? 0)
      - Object.values(phases).reduce((sum, samples) => sum + (samples[frame] ?? 0), 0));
    timeline.endFrame();
  }
  return timeline.report();
}

test('每条线程一行抬头，下面跟着最耗时的阶段', () => {
  const report = reportWith(
    { 'render-draw': [8, 9, 10], 'chunk-geometry': [0, 12, 0] },
    [12, 24, 14],
  );
  const lines = formatFrameProfiler([{ label: '渲染线程', fps: 42, report }]);
  assert.match(lines[0], /^渲染线程/);
  assert.match(lines[0], /42 fps/);
  assert.match(lines[0], /帧 p50=/);
  // 阶段按 p95 排序，chunk-geometry 那一帧的 12ms 必须排在前面被看见。
  assert.match(lines[1], /chunk-geometry/);
  assert.match(lines[2], /render-draw/);
  for (const line of lines.slice(1)) assert.match(line, /n=\s*\d+/);
});

test('阶段数量有上限，面板不会被几十行铺满', () => {
  const phases: Record<string, number[]> = {};
  for (let index = 0; index < DEFAULT_PHASE_LIMIT + 4; index += 1) {
    phases[`phase-${index}`] = [index + 1];
  }
  const lines = formatFrameProfiler([{ label: 'T', report: reportWith(phases, [40]) }]);
  assert.equal(lines.length, 1 + DEFAULT_PHASE_LIMIT);
  const lines2 = formatFrameProfiler([{ label: 'T', report: reportWith(phases, [40]) }], 2);
  assert.equal(lines2.length, 3);
});

test('没有报表时说明原因，而不是显示成 0', () => {
  const [line] = formatFrameProfiler([
    { label: '渲染线程', absentReason: '渲染循环没在独立线程上' },
  ]);
  assert.match(line, /渲染循环没在独立线程上/);
  assert.doesNotMatch(line, /fps/);
});

test('报表过期时标成没有新数据——渲染线程卡死不能显示成一切正常', () => {
  const report = reportWith({ 'render-draw': [8] }, [16]);
  const fresh = formatFrameProfiler([
    { label: '渲染线程', report, ageMilliseconds: STALE_REPORT_MILLISECONDS - 1 },
  ]);
  assert.match(fresh[0], /fps/);

  const stale = formatFrameProfiler([
    { label: '渲染线程', report, ageMilliseconds: STALE_REPORT_MILLISECONDS + 1 },
  ]);
  assert.equal(stale.length, 1, '陈旧报表不该再列阶段');
  assert.match(stale[0], /没有新数据/);
});

test('没传 fps 时退回报表里的帧数——渲染线程每秒清一次，两者相同', () => {
  const report = reportWith({ 'render-draw': [8, 8, 8] }, [16, 16, 16]);
  const [line] = formatFrameProfiler([{ label: '渲染线程', report }]);
  assert.match(line, /3 fps/);
});
