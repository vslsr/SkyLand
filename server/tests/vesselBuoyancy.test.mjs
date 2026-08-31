import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VESSEL_FLOAT_STATES,
  evaluateVesselBuoyancy,
} from '../../shared/vesselBuoyancy.mjs';

const symmetricFloaters = [
  { mass: 10, buoyancy: 80, localX: -1, localZ: -1 },
  { mass: 10, buoyancy: 80, localX: 1, localZ: -1 },
  { mass: 10, buoyancy: 80, localX: -1, localZ: 1 },
  { mass: 10, buoyancy: 80, localX: 1, localZ: 1 },
];

test('充足且对称的浮力保持正常漂浮', () => {
  const result = evaluateVesselBuoyancy([
    ...symmetricFloaters,
    { mass: 120, buoyancy: 0, localX: 0, localZ: 0 },
  ]);

  assert.equal(result.state, VESSEL_FLOAT_STATES.AFLOAT);
  assert.equal(result.totalMass, 160);
  assert.equal(result.effectiveBuoyancy, 320);
  assert.equal(result.loadRatio, 0.5);
  assert.equal(result.trimRoll, 0);
  assert.equal(result.trimPitch, 0);
});

test('接近容量上限时先超载降速而不是直接沉没', () => {
  const result = evaluateVesselBuoyancy(symmetricFloaters, { extraMass: 250 });

  assert.equal(result.state, VESSEL_FLOAT_STATES.OVERLOADED);
  assert.ok(result.speedFactor < 1);
  assert.ok(result.speedFactor >= 0.65);
});

test('浮筒损伤降低有效浮力并进入进水状态', () => {
  const damaged = symmetricFloaters.map((part, index) => ({
    ...part,
    integrity: index < 2 ? 0 : 0.25,
  }));
  const result = evaluateVesselBuoyancy(damaged, { extraMass: 180 });

  assert.equal(result.state, VESSEL_FLOAT_STATES.FLOODING);
  assert.equal(result.effectiveBuoyancy, 40);
  assert.equal(result.speedFactor, 0.35);
});

test('偏心载荷产生有限的静态横倾', () => {
  const result = evaluateVesselBuoyancy([
    ...symmetricFloaters,
    { mass: 140, buoyancy: 0, localX: 0.8, localZ: 0 },
  ]);

  assert.ok(result.trimRoll < 0);
  assert.ok(Math.abs(result.trimRoll) <= 0.1);
});

test('没有任何有效浮力时进入沉没状态且结果不包含 NaN', () => {
  const result = evaluateVesselBuoyancy([
    { mass: 100, buoyancy: 50, integrity: 0, localX: 0, localZ: 0 },
  ]);

  assert.equal(result.state, VESSEL_FLOAT_STATES.SINKING);
  assert.equal(result.speedFactor, 0);
  assert.equal(Number.isNaN(result.trimRoll), false);
  assert.equal(Number.isNaN(result.trimPitch), false);
});
