import assert from 'node:assert/strict';
import test from 'node:test';
import { sampleOceanWaveHeight } from '../src/ocean/oceanWaveMath';

const profile = {
  size: 32,
  segments: 8,
  waveHeight: 0.12,
  waveSpeed: 0.72,
  noiseScale: 0.085,
  noiseStrength: 1.15,
  interlaceStrength: 0.42,
};

test('客户端波形是确定性的并受配置振幅约束', () => {
  const first = sampleOceanWaveHeight(3.5, -7.2, 12.4, profile);
  const second = sampleOceanWaveHeight(3.5, -7.2, 12.4, profile);

  assert.equal(first, second);
  assert.ok(Math.abs(first) <= profile.waveHeight + Number.EPSILON);
});

test('零振幅时无论位置和时间都保持固定海平面偏移为零', () => {
  assert.equal(
    sampleOceanWaveHeight(99, -41, 1234, {
      size: 32,
      segments: 8,
      waveHeight: 0,
      waveSpeed: 4,
      noiseScale: 0.085,
      noiseStrength: 1.15,
      interlaceStrength: 0.42,
    }),
    0,
  );
});

test('噪声相位扰动会打破规则波列但仍受总波高限制', () => {
  const withoutNoise = sampleOceanWaveHeight(7.2, -3.6, 4.5, {
    ...profile,
    noiseStrength: 0,
  });
  const withNoise = sampleOceanWaveHeight(7.2, -3.6, 4.5, profile);

  assert.notEqual(withNoise, withoutNoise);
  assert.ok(Math.abs(withNoise) <= profile.waveHeight + Number.EPSILON);
});

test('时间推进会改变视觉波形但不会产生非有限值', () => {
  const before = sampleOceanWaveHeight(1, 2, 0, profile);
  const after = sampleOceanWaveHeight(1, 2, 1, profile);

  assert.notEqual(before, after);
  assert.ok(Number.isFinite(after));
});

test('相邻网格顶点在纯交错模式下保持反相上下起伏', () => {
  const interlacedProfile = {
    ...profile,
    noiseStrength: 0,
    interlaceStrength: 1,
  };
  const gridStep = interlacedProfile.size / interlacedProfile.segments;
  const first = sampleOceanWaveHeight(0, 0, 0, interlacedProfile);
  const adjacent = sampleOceanWaveHeight(gridStep, 0, 0, interlacedProfile);

  assert.ok(Math.abs(first + adjacent) < 1e-10);
  assert.ok(first > 0);
  assert.ok(adjacent < 0);
});
