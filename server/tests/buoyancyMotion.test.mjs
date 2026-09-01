import assert from 'node:assert/strict';
import test from 'node:test';
import { sampleBuoyancyBobOffset } from '../../shared/actor/buoyancyMotion.mjs';

test('浮力波形按 Actor 稳定并严格限制在配置振幅内', () => {
  const amplitude = 0.3;
  let minimum = Infinity;
  let maximum = -Infinity;
  for (let step = 0; step < 500; step += 1) {
    const time = step / 60;
    const value = sampleBuoyancyBobOffset('player-1', time, amplitude, 0.55);
    assert.equal(value, sampleBuoyancyBobOffset('player-1', time, amplitude, 0.55));
    assert.ok(Math.abs(value) <= amplitude + Number.EPSILON);
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  assert.ok(maximum - minimum > amplitude * 1.7, '完整周期应接近配置的峰谷振幅');
  assert.equal(sampleBuoyancyBobOffset('player-1', 1, 0, 0.55), 0);
});
