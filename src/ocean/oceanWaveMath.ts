export interface OceanWaveParameters {
  waveHeight: number;
  waveSpeed: number;
  noiseScale: number;
  noiseStrength: number;
  size: number;
  segments: number;
  interlaceStrength: number;
}

export const OCEAN_WAVE_TERMS = [
  { functionName: 'sin', xFrequency: 0.23, zFrequency: 0, timeFrequency: 0.72, noisePhase: 1, weight: 0.42 },
  { functionName: 'cos', xFrequency: 0, zFrequency: 0.19, timeFrequency: -0.54, noisePhase: -0.73, weight: 0.3 },
  { functionName: 'sin', xFrequency: 0.13, zFrequency: 0.13, timeFrequency: 0.38, noisePhase: 1.31, weight: 0.18 },
  { functionName: 'cos', xFrequency: 0.37, zFrequency: -0.37, timeFrequency: -0.91, noisePhase: -0.47, weight: 0.1 },
] as const;

function fract(value: number): number {
  return value - Math.floor(value);
}

function mix(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function hashGrid(x: number, z: number): number {
  return fract(Math.sin(x * 127.1 + z * 311.7) * 43758.5453123);
}

export function sampleOceanValueNoise(x: number, z: number): number {
  const cellX = Math.floor(x);
  const cellZ = Math.floor(z);
  const localX = fract(x);
  const localZ = fract(z);
  const smoothX = localX * localX * (3 - 2 * localX);
  const smoothZ = localZ * localZ * (3 - 2 * localZ);
  const near = mix(hashGrid(cellX, cellZ), hashGrid(cellX + 1, cellZ), smoothX);
  const far = mix(hashGrid(cellX, cellZ + 1), hashGrid(cellX + 1, cellZ + 1), smoothX);
  return mix(near, far, smoothZ);
}

export function sampleOceanNoiseWarp(
  x: number,
  z: number,
  elapsedSeconds: number,
  parameters: OceanWaveParameters,
): number {
  const time = elapsedSeconds * parameters.waveSpeed;
  const scale = parameters.noiseScale;
  const primary = sampleOceanValueNoise(x * scale + time * 0.035, z * scale - time * 0.028);
  const crossing = sampleOceanValueNoise(
    (x + z) * scale * 1.7 - time * 0.021,
    (z - x) * scale * 1.3 + time * 0.024,
  );
  return ((primary * 0.62 + crossing * 0.38) * 2 - 1) * parameters.noiseStrength;
}

/**
 * 只用于客户端表现的低振幅确定性波形。服务端浮力永远使用固定海平面。
 * 四项权重之和为 1，因此输出严格限制在大约 ±waveHeight 内。
 */
export function sampleOceanWaveHeight(
  x: number,
  z: number,
  elapsedSeconds: number,
  parameters: OceanWaveParameters,
): number {
  if (parameters.waveHeight === 0) return 0;
  const time = elapsedSeconds * parameters.waveSpeed;
  const noiseWarp = sampleOceanNoiseWarp(x, z, elapsedSeconds, parameters);
  let wave = 0;
  for (const term of OCEAN_WAVE_TERMS) {
    const phase =
      x * term.xFrequency +
      z * term.zFrequency +
      time * term.timeFrequency +
      noiseWarp * term.noisePhase;
    wave += (term.functionName === 'sin' ? Math.sin(phase) : Math.cos(phase)) * term.weight;
  }
  const gridStep = parameters.size / parameters.segments;
  const checker = Math.cos(Math.PI * (x + z) / gridStep);
  const interlacedWave = checker * Math.sin(time * 1.28 + 0.65);
  return mix(wave, interlacedWave, parameters.interlaceStrength) * parameters.waveHeight;
}
