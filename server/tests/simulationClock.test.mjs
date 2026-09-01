import test from 'node:test';
import assert from 'node:assert/strict';
import { SimulationClock } from '../../shared/physics/simulationClock.mjs';

function countSteps(frameRate, seconds = 1) {
  const clock = new SimulationClock();
  let steps = 0;
  for (let frame = 0; frame < frameRate * seconds; frame += 1) {
    clock.advance(1 / frameRate, () => { steps += 1; });
  }
  return steps;
}

test('30Hz、60Hz 与 120Hz 渲染产生相同的 60Hz 轨迹步数', () => {
  assert.equal(countSteps(30), 60);
  assert.equal(countSteps(60), 60);
  assert.equal(countSteps(120), 60);
});

test('后台恢复单帧最多补跑五步', () => {
  const clock = new SimulationClock();
  let steps = 0;
  clock.advance(10, () => { steps += 1; });
  assert.equal(steps, 5);
  assert.ok(clock.alpha >= 0 && clock.alpha < 1);
});
