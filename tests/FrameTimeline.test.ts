import assert from 'node:assert/strict';
import test from 'node:test';
import { FrameTimeline, formatFrameTimingReport } from '../src/platform/FrameTimeline';

/** 可控时钟：打点的断言不能依赖真实耗时。 */
function createClock(): { now(): number; advance(milliseconds: number): void } {
  let value = 0;
  return {
    now: () => value,
    advance: (milliseconds: number) => { value += milliseconds; },
  };
}

test('同一阶段一帧内被打点多次时累加，而不是只留最后一次', () => {
  const clock = createClock();
  const timeline = new FrameTimeline(clock);
  timeline.beginFrame();
  timeline.measure('chunk-gen', () => clock.advance(3));
  timeline.measure('chunk-gen', () => clock.advance(5));
  timeline.endFrame();

  const report = timeline.report();
  const phase = report.phases.find((entry) => entry.phase === 'chunk-gen');
  assert.equal(phase?.median, 8);
  assert.equal(phase?.frames, 1);
});

test('缺席的帧不占分位数的位置', () => {
  const clock = createClock();
  const timeline = new FrameTimeline(clock);
  // 三帧里只有一帧建了 chunk：那一帧的耗时不该被另外两个 0 稀释成中位数 0。
  for (const build of [false, true, false]) {
    timeline.beginFrame();
    if (build) timeline.measure('chunk-gen', () => clock.advance(12));
    timeline.measure('draw', () => clock.advance(2));
    timeline.endFrame();
    clock.advance(1);
  }
  const report = timeline.report();
  assert.equal(report.frames, 3);
  assert.equal(report.phases.find((entry) => entry.phase === 'chunk-gen')?.median, 12);
  assert.equal(report.phases.find((entry) => entry.phase === 'chunk-gen')?.frames, 1);
  assert.equal(report.phases.find((entry) => entry.phase === 'draw')?.frames, 3);
});

test('抛异常的阶段仍然被记账，不会把打点挂在半空', () => {
  const clock = createClock();
  const timeline = new FrameTimeline(clock);
  timeline.beginFrame();
  assert.throws(() => timeline.measure('boom', () => {
    clock.advance(4);
    throw new Error('boom');
  }));
  timeline.endFrame();
  assert.equal(timeline.report().phases[0]?.median, 4);
});

test('整帧耗时包含没有打点的那部分', () => {
  const clock = createClock();
  const timeline = new FrameTimeline(clock);
  timeline.beginFrame();
  timeline.measure('sim', () => clock.advance(4));
  clock.advance(6); // 没打点的部分
  timeline.endFrame();
  const report = timeline.report();
  assert.equal(report.frameMedian, 10);
  assert.equal(report.phases[0]?.median, 4);
});

test('环形窗口只保留最近 capacity 帧', () => {
  const clock = createClock();
  const timeline = new FrameTimeline(clock, 2);
  for (const cost of [1, 2, 3]) {
    timeline.beginFrame();
    timeline.measure('sim', () => clock.advance(cost));
    timeline.endFrame();
  }
  const report = timeline.report();
  assert.equal(report.frames, 2);
  assert.equal(report.phases[0]?.maximum, 3);
  assert.equal(report.phases[0]?.median, 3);
});

test('关掉之后 measure 仍然执行 body，只是不再记账', () => {
  const clock = createClock();
  const timeline = new FrameTimeline(clock);
  timeline.setEnabled(false);
  let ran = false;
  timeline.beginFrame();
  timeline.measure('sim', () => { ran = true; clock.advance(5); });
  timeline.endFrame();
  assert.equal(ran, true);
  assert.equal(timeline.report().frames, 0);
});

test('报表按 p95 从大到小排，文本里每个阶段一行', () => {
  const clock = createClock();
  const timeline = new FrameTimeline(clock);
  timeline.beginFrame();
  timeline.measure('draw', () => clock.advance(2));
  timeline.measure('chunk-gen', () => clock.advance(9));
  timeline.measure('sim', () => clock.advance(5));
  timeline.endFrame();
  const report = timeline.report();
  assert.deepEqual(report.phases.map((entry) => entry.phase), ['chunk-gen', 'sim', 'draw']);
  const text = formatFrameTimingReport(report);
  assert.equal(text.split('\n').length, 4);
  assert.match(text, /chunk-gen/);
});

test('嵌套阶段记自耗时：父阶段扣掉子阶段的整段耗时', () => {
  const clock = createClock();
  const timeline = new FrameTimeline(clock);
  timeline.beginFrame();
  timeline.measure('sim-actors', () => {
    clock.advance(2);
    timeline.measure('render-spawn', () => clock.advance(7));
    clock.advance(1);
  });
  timeline.endFrame();

  const report = timeline.report();
  // 父 10ms 里有 7ms 是子的：父只记 3ms，两者之和正好等于整帧。
  assert.equal(report.phases.find((entry) => entry.phase === 'sim-actors')?.median, 3);
  assert.equal(report.phases.find((entry) => entry.phase === 'render-spawn')?.median, 7);
  assert.equal(report.frameMedian, 10);
});

test('嵌套里抛异常也不会把栈留在半空', () => {
  const clock = createClock();
  const timeline = new FrameTimeline(clock);
  timeline.beginFrame();
  assert.throws(() => timeline.measure('outer', () => {
    timeline.measure('inner', () => {
      clock.advance(3);
      throw new Error('boom');
    });
  }));
  clock.advance(1);
  timeline.measure('after', () => clock.advance(2));
  timeline.endFrame();

  const report = timeline.report();
  assert.equal(report.phases.find((entry) => entry.phase === 'inner')?.median, 3);
  assert.equal(report.phases.find((entry) => entry.phase === 'outer')?.median, 0);
  // 关键：'after' 没有被误当成 'outer' 的子阶段扣掉。
  assert.equal(report.phases.find((entry) => entry.phase === 'after')?.median, 2);
});
