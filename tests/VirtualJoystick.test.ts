import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampVirtualJoystickCenter,
  sampleVirtualJoystick,
} from '../src/input/ui/virtualJoystickMath.ts';

test('浮动摇杆中心会被限制在激活区域内并保留完整基座', () => {
  assert.deepEqual(
    clampVirtualJoystickCenter(8, 290, { width: 240, height: 300, margin: 60 }),
    { x: 60, y: 240 },
  );
  assert.deepEqual(
    clampVirtualJoystickCenter(30, 20, { width: 40, height: 30, margin: 60 }),
    { x: 20, y: 15 },
  );
});

test('死区内保留摇杆视觉位移但输出零向量', () => {
  const sample = sampleVirtualJoystick(3, -4, 50, 0.15, 1);
  assert.deepEqual({ x: sample.offsetX, y: sample.offsetY }, { x: 3, y: -4 });
  assert.deepEqual(sample.value, { x: 0, y: 0 });
});

test('摇杆限制视觉行程、翻转屏幕 Y 轴并把输出钳制到单位圆', () => {
  const sample = sampleVirtualJoystick(80, -60, 50, 0.08, 1.2);
  assert.ok(Math.abs(Math.hypot(sample.offsetX, sample.offsetY) - 50) < 1e-9);
  assert.ok(sample.value.x > 0);
  assert.ok(sample.value.y > 0);
  assert.ok(Math.abs(Math.hypot(sample.value.x, sample.value.y) - 1) < 1e-9);
});

test('死区外的径向重映射保持方向并应用灵敏度', () => {
  const normal = sampleVirtualJoystick(25, 0, 100, 0.1, 1);
  const sensitive = sampleVirtualJoystick(25, 0, 100, 0.1, 1.5);
  assert.equal(normal.value.y, 0);
  assert.ok(normal.value.x > 0);
  assert.ok(sensitive.value.x > normal.value.x);
  assert.ok(sensitive.value.x <= 1);
});

