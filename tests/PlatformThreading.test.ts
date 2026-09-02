import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateSharedBytes,
  describeThreadingCapabilities,
  detectThreadingCapabilities,
  isSharedBytes,
  type ThreadingScope,
} from '../src/platform/index';

const browserLike = (overrides: Partial<ThreadingScope> = {}): ThreadingScope => ({
  crossOriginIsolated: true,
  SharedArrayBuffer,
  Atomics,
  Worker: class {},
  OffscreenCanvas: class {},
  ...overrides,
});

test('跨源隔离打开时共享内存可用', () => {
  const capabilities = detectThreadingCapabilities(browserLike());
  assert.equal(capabilities.crossOriginIsolated, true);
  assert.equal(capabilities.sharedMemory, true);
  assert.equal(capabilities.workers, true);
  assert.equal(capabilities.offscreenCanvas, true);
  assert.equal(capabilities.atomics, true);
});

test('未隔离的文档即使暴露 SharedArrayBuffer 构造器也不算有共享内存', () => {
  // 浏览器在未隔离时仍然保留构造器，但 new 出来的 buffer 不能跨线程投递。
  // 「有构造器」当成「能共享」会让 worker 上线那天才炸。
  const capabilities = detectThreadingCapabilities(browserLike({ crossOriginIsolated: false }));
  assert.equal(capabilities.crossOriginIsolated, false);
  assert.equal(capabilities.sharedMemory, false);
});

test('没有 crossOriginIsolated 概念的宿主按构造器判断', () => {
  // Node（测试与房间进程）不定义这个全局量，但 SAB 一直可用。
  const capabilities = detectThreadingCapabilities({ SharedArrayBuffer, Atomics });
  assert.equal(capabilities.crossOriginIsolated, false);
  assert.equal(capabilities.sharedMemory, true);
});

test('拿不到共享内存时回落成普通 ArrayBuffer，读写语义不变', () => {
  const shared = allocateSharedBytes(16, browserLike());
  assert.equal(isSharedBytes(shared), true);
  assert.equal(shared.byteLength, 16);

  const fallback = allocateSharedBytes(16, browserLike({ crossOriginIsolated: false }));
  assert.equal(isSharedBytes(fallback), false);
  assert.equal(fallback.byteLength, 16);

  for (const buffer of [shared, fallback]) {
    const view = new Float32Array(buffer);
    view[1] = 2.5;
    assert.equal(new Float32Array(buffer)[1], 2.5);
  }
});

test('能力摘要把静默降级写成可读的一行', () => {
  assert.equal(
    describeThreadingCapabilities(detectThreadingCapabilities(browserLike())),
    'isolated · shared-memory · workers · offscreen-canvas',
  );
  assert.match(
    describeThreadingCapabilities(detectThreadingCapabilities({})),
    /not-isolated · no-shared-memory/,
  );
});
