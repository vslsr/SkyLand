import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrameStatsPanel } from '../src/debug/FrameStatsPanel.ts';
import { isDevelopmentRuntime } from '../src/debug/developmentRuntime.ts';

test('本机组合服务器在生产 bundle 中仍被识别为开发运行时', () => {
  assert.equal(isDevelopmentRuntime({ hostname: 'localhost' }), true);
  assert.equal(isDevelopmentRuntime({ hostname: '127.0.0.1' }), true);
  assert.equal(isDevelopmentRuntime({ hostname: '[::1]' }), true);
});

test('非回环生产地址不会启用开发调试入口', () => {
  assert.equal(isDevelopmentRuntime({ hostname: 'skyland.example.com' }), false);
  assert.equal(isDevelopmentRuntime({ hostname: '192.168.1.20' }), false);
  assert.equal(isDevelopmentRuntime(undefined), false);
});

test('生产运行时不装载帧率面板，也不去碰 stats-gl 和 DOM', async () => {
  // Node 里既没有 location 也没有 import.meta.env.DEV，等价于线上非回环地址。
  // 闸门一旦被拿掉，这里会先崩在 document 上——那正是要拦的那种改动。
  assert.equal(
    await createFrameStatsPanel({ canvas: undefined as never }),
    undefined,
  );
});
