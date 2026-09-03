import assert from 'node:assert/strict';
import test from 'node:test';
import { GpuFrameTimer, type GpuTimerGl, type GpuTimerQuery } from '../src/render/GpuFrameTimer';

/**
 * 渲染线程上的 GPU 帧耗时（`EXT_disjoint_timer_query_webgl2`）。
 *
 * 用一个假的 gl 把「结果几帧之后才好」「不连续期间作废」这两条规范行为写死，
 * 看计时器收的账对不对。
 */

interface FakeQuery extends GpuTimerQuery { id: number; nanoseconds?: number; ready: boolean }

function fakeGl(options: { extension?: boolean } = {}) {
  const queries: FakeQuery[] = [];
  const state = { active: undefined as FakeQuery | undefined, disjoint: false, deleted: 0 };
  const gl: GpuTimerGl = {
    QUERY_RESULT: 0x8866,
    QUERY_RESULT_AVAILABLE: 0x8867,
    getExtension: (name) => (name === 'EXT_disjoint_timer_query_webgl2' && options.extension !== false
      ? { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb }
      : null),
    createQuery: () => { const query = { id: queries.length, ready: false }; queries.push(query); return query; },
    deleteQuery: () => { state.deleted += 1; },
    beginQuery: (_target, query) => { state.active = query as FakeQuery; },
    endQuery: () => { state.active = undefined; },
    getQueryParameter: (query, pname) => {
      const fake = query as FakeQuery;
      if (pname === gl.QUERY_RESULT_AVAILABLE) return fake.ready;
      return fake.nanoseconds ?? 0;
    },
    getParameter: () => state.disjoint,
  };
  return { gl, queries, state };
}

test('扩展不可用：全是空操作，报表里 gpuFrames 恒为 0', () => {
  const { gl } = fakeGl({ extension: false });
  const timer = new GpuFrameTimer(gl);
  assert.equal(timer.available, false);
  timer.begin();
  timer.end();
  timer.poll();
  assert.deepEqual(timer.report(), { gpuFrames: 0, gpuMedianMs: 0, gpuMaximumMs: 0 });
});

test('结果几帧之后才好：按提交顺序收，报表给中位数与最大值（毫秒）', () => {
  const { gl, queries } = fakeGl();
  const timer = new GpuFrameTimer(gl);
  assert.ok(timer.available);
  for (let frame = 0; frame < 3; frame += 1) {
    timer.begin();
    timer.end();
    timer.poll();
  }
  assert.equal(timer.report().gpuFrames, 0, '还没有结果');
  queries[0].ready = true; queries[0].nanoseconds = 4e6;
  queries[1].ready = true; queries[1].nanoseconds = 12e6;
  // 第三个还没好，前两个能收。
  timer.poll();
  const report = timer.report();
  assert.equal(report.gpuFrames, 2);
  assert.equal(report.gpuMedianMs, 12);
  assert.equal(report.gpuMaximumMs, 12);
  queries[2].ready = true; queries[2].nanoseconds = 7e6;
  timer.poll();
  assert.deepEqual(timer.report(), { gpuFrames: 1, gpuMedianMs: 7, gpuMaximumMs: 7 });
});

test('GPU_DISJOINT 期间的结果作废，不进账', () => {
  const { gl, queries, state } = fakeGl();
  const timer = new GpuFrameTimer(gl);
  timer.begin(); timer.end();
  queries[0].ready = true; queries[0].nanoseconds = 5e6;
  state.disjoint = true;
  timer.poll();
  assert.equal(timer.report().gpuFrames, 0);
  assert.equal(state.deleted, 1, '查询照样回收');
});

test('在飞的查询封顶：显卡卡死时不会无限堆', () => {
  const { gl, queries } = fakeGl();
  const timer = new GpuFrameTimer(gl);
  for (let frame = 0; frame < 20; frame += 1) { timer.begin(); timer.end(); }
  assert.ok(queries.length <= 8, `在飞 ${queries.length} 个`);
});
