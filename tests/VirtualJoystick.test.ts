import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampVirtualJoystickCenter,
  isVirtualAimCharging,
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


test('瞄准摇杆的两层：推进外层才蓄力，界线上抖一下不打断这一次', () => {
  const inner = 32 / 48;
  // 内层里只瞄准，不蓄力。
  assert.equal(isVirtualAimCharging(0.3, inner, false), false);
  assert.equal(isVirtualAimCharging(inner, inner, false), false, '正好在界线上还不算推出去');
  // 推过内层那一圈：开始蓄力。
  assert.equal(isVirtualAimCharging(0.8, inner, false), true);
  // 回滞：已经在蓄力时，缩回界线附近仍然算蓄着——否则手指停在线上会让弓一帧
  // 一拉一松，而每一次都是一次真的 use:begin / cancel。
  assert.equal(isVirtualAimCharging(inner - 0.03, inner, true), true);
  // 缩回去够多才松开。
  assert.equal(isVirtualAimCharging(inner - 0.2, inner, true), false);
});
