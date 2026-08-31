import assert from 'node:assert/strict';
import test from 'node:test';
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
