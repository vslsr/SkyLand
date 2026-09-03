import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { RenderFramePacer, type FrameWaitSource } from '../src/render/worker/RenderFramePacer';
import { RenderTransformBuffer, type FrameWaitResult } from '../src/render/RenderTransformBuffer';

/**
 * 渲染线程每拍「等主线程翻面再画」的那一等（录像里一顿一顿的来源，见
 * `RenderFramePacer` 的类注释）。
 *
 * 等待本身是注入的，所以这里能用一个假的帧源把「主线程什么时候翻面」写死，
 * 逐拍检查节拍器的决定与记账；最后一条再用真的 `RenderTransformBuffer` 加一条
 * `worker_threads` 线程，验证 `publish()` 的 `Atomics.notify` 真能把等的人叫醒。
 */

/** 假帧源：`waitForFrame` 按剧本回答，并把每次被问到的预算记下来。 */
function fakeSource(script: {
  frameId: number;
  onWait?: (frameId: number, timeoutMs: number) => FrameWaitResult;
}): FrameWaitSource & { readonly waits: { frameId: number; timeoutMs: number }[] } {
  const waits: { frameId: number; timeoutMs: number }[] = [];
  return {
    waits,
    get frameId() { return script.frameId; },
    waitForFrame(frameId, timeoutMs) {
      waits.push({ frameId, timeoutMs });
      return script.onWait?.(frameId, timeoutMs) ?? 'timed-out';
    },
  };
}

const fixedClock = (ticks: number[]) => ({ now: () => ticks.shift() ?? 0 });

test('主线程已经翻过面：不等，直接画这一帧', () => {
  const pacer = new RenderFramePacer();
  const source = fakeSource({ frameId: 7 });
  pacer.beginFrame(0);
  const first = pacer.acquire(source, fixedClock([0, 0]));
  assert.equal(first.frameId, 7);
  assert.equal(first.waitedMs, 0);
  assert.equal(source.waits.length, 0, '帧号比上次新就不该等');

  // 下一拍主线程又翻了一面，同样不等。
  Object.assign(source, {});
  const script = { frameId: 8 };
  const next = fakeSource(script);
  pacer.beginFrame(16.7);
  const second = pacer.acquire(next, fixedClock([0, 0]));
  assert.equal(second.frameId, 8);
  assert.equal(second.advanced, 1, '正好推进一帧');
  assert.equal(next.waits.length, 0);
});

test('主线程还没翻面：按预算等，等到了就画新的那一帧', () => {
  const pacer = new RenderFramePacer();
  const script = { frameId: 3, onWait: undefined as FrameWaitSource['waitForFrame'] | undefined };
  const source = fakeSource(script);
  pacer.beginFrame(0);
  pacer.acquire(source, fixedClock([0, 0]));
  pacer.endFrame(4);

  // 主线程在等待期间翻面：waitForFrame 返回 'ok'，帧号变成 4。
  script.onWait = () => { script.frameId = 4; return 'ok'; };
  pacer.beginFrame(16.7);
  const acquired = pacer.acquire(source, fixedClock([10, 13]));
  assert.equal(acquired.frameId, 4);
  assert.equal(acquired.wait, 'ok');
  assert.equal(acquired.waitedMs, 3, '等了 3ms');
  assert.equal(acquired.advanced, 1);
  assert.equal(source.waits.length, 1);
  assert.equal(source.waits[0].frameId, 3, '等的是「帧号还等于 3」这件事');

  const report = pacer.report();
  assert.equal(report.frames, 2);
  assert.equal(report.duplicated, 0);
  assert.equal(report.skipped, 0);
  assert.equal(report.waitTimeouts, 0);
  assert.equal(report.waitMedianMs, 3);
});

test('等到上限主线程还没翻面：画上一帧，记成重复与一次超时', () => {
  const pacer = new RenderFramePacer();
  const source = fakeSource({ frameId: 5 });
  pacer.beginFrame(0);
  pacer.acquire(source, fixedClock([0, 0]));
  pacer.endFrame(3);

  pacer.beginFrame(16.7);
  const acquired = pacer.acquire(source, fixedClock([0, 12]));
  assert.equal(acquired.frameId, 5);
  assert.equal(acquired.advanced, 0);
  assert.equal(acquired.wait, 'timed-out');
  const report = pacer.report();
  assert.equal(report.duplicated, 1);
  assert.equal(report.waitTimeouts, 1);
  assert.equal(report.waitMaximumMs, 12);
});

test('等待预算 = rAF 间隔 − 上一帧绘制耗时 − 余量，并封在间隔的四分之三以内', () => {
  const pacer = new RenderFramePacer({ marginMs: 1, maximumWaitFraction: 0.75, initialIntervalMs: 1000 / 60 });
  // 还没量到间隔：按 60Hz 算。上一帧画了 4ms → 16.67 − 4 − 1 = 11.67。
  pacer.endFrame(4);
  assert.ok(Math.abs(pacer.waitBudgetMs() - (1000 / 60 - 5)) < 1e-9);
  // 画得很快时封顶：不超过间隔的 75%。
  pacer.endFrame(0);
  assert.ok(Math.abs(pacer.waitBudgetMs() - (1000 / 60) * 0.75) < 1e-9);
  // 画得比一拍还久：一点都不等。
  pacer.endFrame(20);
  assert.equal(pacer.waitBudgetMs(), 0);

  // 144Hz 的屏幕：相邻 rAF 时间戳差 6.94ms，预算跟着收紧。
  const fast = new RenderFramePacer();
  for (let frame = 0; frame < 9; frame += 1) fast.beginFrame(frame * (1000 / 144));
  assert.ok(Math.abs(fast.rafIntervalMs - 1000 / 144) < 1e-6);
  fast.endFrame(2);
  assert.ok(fast.waitBudgetMs() < 1000 / 144);

  // 切标签页回来那一拍隔了很久，不能把间隔估成几百毫秒。
  fast.beginFrame(9 * (1000 / 144) + 5000);
  assert.ok(Math.abs(fast.rafIntervalMs - 1000 / 144) < 1e-6);
});

test('主线程一拍翻了两面：画最新的，记成一次跳过', () => {
  const pacer = new RenderFramePacer();
  const script = { frameId: 10 };
  const source = fakeSource(script);
  pacer.beginFrame(0);
  pacer.acquire(source, fixedClock([0, 0]));
  script.frameId = 12;
  pacer.beginFrame(16.7);
  const acquired = pacer.acquire(source, fixedClock([0, 0]));
  assert.equal(acquired.frameId, 12);
  assert.equal(acquired.advanced, 2);
  assert.equal(pacer.report().skipped, 1);
});

test('?renderpace=free：不等，只记账', () => {
  const pacer = new RenderFramePacer({ waitEnabled: false });
  const source = fakeSource({ frameId: 1 });
  pacer.beginFrame(0);
  pacer.acquire(source, fixedClock([0, 0]));
  pacer.beginFrame(16.7);
  const acquired = pacer.acquire(source, fixedClock([0, 0]));
  assert.equal(source.waits.length, 0, '关掉之后一次都不等');
  assert.equal(acquired.advanced, 0);
  assert.equal(pacer.report().duplicated, 1, '重复照样数出来，面板上才对照得出差别');
});

/**
 * 真的等一次：另一条线程拿着同一块 SharedArrayBuffer，5ms 后 `publish()`。
 * `Atomics.notify` 要能把这一侧从 `waitForFrame` 里叫醒，而不是等到超时。
 */
test('publish() 叫醒另一条线程里等这一帧的人', async () => {
  const buffer = new RenderTransformBuffer(4);
  assert.ok(buffer.isShared, 'Node 上 SharedArrayBuffer 一直可用');
  const before = buffer.frameId;
  const worker = new Worker(
    `
    const { workerData, parentPort } = require('node:worker_threads');
    const header = new Int32Array(workerData.bytes, 0, 4);
    setTimeout(() => {
      // 和 RenderTransformBuffer.publish() 同一套动作：帧号 +1 然后 notify。
      Atomics.add(header, 1, 1);
      Atomics.notify(header, 1);
      parentPort.postMessage('published');
    }, 5);
    `,
    { eval: true, workerData: { bytes: buffer.bytes } },
  );
  try {
    const startedAt = performance.now();
    const result = buffer.waitForFrame(before, 2000);
    const waited = performance.now() - startedAt;
    assert.equal(result, 'ok', '应该是被叫醒的，不是超时');
    assert.equal(buffer.frameId, before + 1);
    assert.ok(waited < 1000, `等了 ${waited.toFixed(1)}ms，说明 notify 没起作用`);
  } finally {
    await worker.terminate();
  }
});

test('帧号已经不等于要等的值时立刻返回 not-equal；普通 ArrayBuffer 与主线程一律不等', () => {
  const buffer = new RenderTransformBuffer(2);
  buffer.publish();
  assert.equal(buffer.waitForFrame(0, 50), 'not-equal');
  // 预算为 0 也不等。
  assert.equal(buffer.waitForFrame(buffer.frameId, 0), 'unsupported');
});

test('adoptBytes 就地换字节：握着同一个对象的人读到的是新内存', () => {
  const writer = new RenderTransformBuffer(2);
  const reader = RenderTransformBuffer.fromBytes(writer.bytes);
  const holder = { transforms: reader };
  let grown: ArrayBufferLike | undefined;
  writer.onGrow((bytes) => { grown = bytes; });
  writer.ensureSlot(7);
  assert.ok(grown, '扩容要回报新字节');
  writer.write(7 as never, 1, 2, 3, 0);
  writer.publish();

  reader.adoptBytes(grown!);
  const out = holder.transforms.readTransform(7 as never, { x: 0, y: 0, z: 0, yaw: 0 });
  assert.deepEqual(out, { x: 1, y: 2, z: 3, yaw: 0 }, '同一个对象、新的一块内存');
  assert.ok(holder.transforms.capacity >= 8);
  assert.throws(() => reader.adoptBytes(new ArrayBuffer(8)), /不像 RenderTransformBuffer/);
});
