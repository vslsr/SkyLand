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
  // 两条线的窗口不一样长，抬头必须写清这次统计了多少帧。
  assert.match(lines[0], /取样 3 帧/);
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

test('帧配对单独占一行：两条循环都满帧也能看出画面在哪几帧上顿', () => {
  const report = reportWith({ 'render-draw': [1, 1, 1] }, [2, 2, 2]);
  const lines = formatFrameProfiler([{
    label: '渲染线程',
    report,
    pacing: { frames: 61, duplicated: 12, skipped: 11, worstMilliseconds: 0, worstSecondsAgo: 0 },
  }]);
  const pacing = lines.find((line) => line.includes('帧配对'));
  assert.ok(pacing, '应该有帧配对那一行');
  assert.match(pacing, /一对一=\s*38/);
  assert.match(pacing, /重复=\s*12/);
  assert.match(pacing, /跳过=\s*11/);
  assert.match(pacing, /画面在这 23 帧上顿/);
});

test('配对完美时不喊「顿」，没有 pacing 时整行不出现', () => {
  const report = reportWith({ 'render-draw': [1] }, [2]);
  const [, clean] = formatFrameProfiler([{
    label: '渲染线程',
    report,
    pacing: { frames: 60, duplicated: 0, skipped: 0, worstMilliseconds: 0, worstSecondsAgo: 0 },
  }]);
  assert.match(clean, /一对一=\s*60/);
  assert.doesNotMatch(clean, /顿/);

  const withoutPacing = formatFrameProfiler([{ label: '主线程', report }]);
  assert.ok(!withoutPacing.some((line) => line.includes('帧配对')));
});

test('近十秒最差帧跨窗口留着——卡顿几秒一次，只看当前这一秒会错过', () => {
  const report = reportWith({ 'render-draw': [1] }, [2]);
  const lines = formatFrameProfiler([{
    label: '渲染线程',
    report,
    pacing: {
      frames: 60,
      duplicated: 0,
      skipped: 0,
      worstMilliseconds: 84.2,
      worstSecondsAgo: 6.4,
    },
  }]);
  const worst = lines.find((line) => line.includes('近十秒最差'));
  assert.ok(worst, '应该有近十秒最差那一行');
  assert.match(worst, /84\.20ms/);
  assert.match(worst, /6\.4s 前/);

  // 还没出现过慢帧时不占一行。
  const quiet = formatFrameProfiler([{
    label: '渲染线程',
    report,
    pacing: { frames: 60, duplicated: 0, skipped: 0, worstMilliseconds: 0, worstSecondsAgo: 0 },
  }]);
  assert.ok(!quiet.some((line) => line.includes('近十秒最差')));
});
