import * as THREE from 'three';

/**
 * 草地共用的一张可平铺噪声贴图。
 *
 * 四个通道各管一件事，合成一张而不是四张，是因为顶点着色器里每多一次
 * 纹理采样就是每片草叶每个顶点多一次；通道拆开只是 swizzle，不额外收费。
 *
 * - `r` 团簇高度：低频，决定「这一片草长得高还是矮」。
 * - `g` 阵风：中频，滚动之后形成有前沿的风团，风过境靠它。
 * - `b` 细颤：高频，叠在阵风上让单叶抖动不整齐。
 * - `a` 色斑：极低频，混出偏枯和偏嫩的地块。
 *
 * 大世界注意事项：贴图是**可平铺**的，采样用世界坐标乘一个很小的缩放再让
 * `RepeatWrapping` 取模，所以内存是常数（一张 128²），既不随世界面积增长，
 * 也不需要按 chunk 生成各自的噪声。
 */

/** 贴图边长。128² RGBA = 64 KiB，常驻一份。 */
const NOISE_TEXTURE_SIZE = 128;
const NOISE_TEXTURE_SEED = 0x9e37_79b9;

/** 每个通道的基础栅格数（必须整除贴图尺寸才能无缝平铺）。 */
const CHANNEL_BASE_PERIODS = Object.freeze([8, 16, 32, 4]);
/** 每个通道叠几个倍频。越多越碎，代价只在生成时的一次性 CPU。 */
const CHANNEL_OCTAVES = Object.freeze([3, 3, 2, 2]);

let sharedTexture: THREE.DataTexture | undefined;
let sharedReferenceCount = 0;

/**
 * 取共享噪声贴图。
 *
 * 走引用计数而不是「每个系统建一张」：固定场景的 `GrassFieldSystem` 与流式
 * 世界的 `StreamingGrassSystem` 可能同时存在，换场景时也会来回创建销毁，
 * 共享一份能让显存占用与场景数量无关。
 */
export function acquireGrassNoiseTexture(): THREE.DataTexture {
  if (!sharedTexture) sharedTexture = createGrassNoiseTexture();
  sharedReferenceCount += 1;
  return sharedTexture;
}

/** 归还共享贴图；最后一个持有者离开时才真正释放显存。 */
export function releaseGrassNoiseTexture(texture: THREE.DataTexture): void {
  if (texture !== sharedTexture) {
    texture.dispose();
    return;
  }
  sharedReferenceCount -= 1;
  if (sharedReferenceCount > 0) return;
  sharedReferenceCount = 0;
  sharedTexture.dispose();
  sharedTexture = undefined;
}

/**
 * 生成一张确定性的可平铺噪声贴图。
 *
 * 同一个 seed 在任何机器上得到逐字节相同的结果，所以草的高低差在所有客户端
 * 一致——它虽然只是表现，但玩家会用「那丛高草」互相指路。
 */
export function createGrassNoiseTexture(
  size: number = NOISE_TEXTURE_SIZE,
  seed: number = NOISE_TEXTURE_SEED,
): THREE.DataTexture {
  const resolution = Math.max(4, Math.floor(size));
  const data = new Uint8Array(resolution * resolution * 4);

  for (let channel = 0; channel < 4; channel += 1) {
    const basePeriod = wrappablePeriod(CHANNEL_BASE_PERIODS[channel], resolution);
    const octaves = CHANNEL_OCTAVES[channel];
    for (let y = 0; y < resolution; y += 1) {
      for (let x = 0; x < resolution; x += 1) {
        const value = tileableFractalNoise(
          x / resolution,
          y / resolution,
          basePeriod,
          octaves,
          resolution,
          seed + channel * 0x27d4_eb2d,
        );
        data[(y * resolution + x) * 4 + channel] = Math.round(
          Math.min(1, Math.max(0, value)) * 255,
        );
      }
    }
  }

  const texture = new THREE.DataTexture(data, resolution, resolution, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * 倍频叠加。高倍频的栅格数会翻倍，必须仍然整除贴图尺寸，
 * 否则接缝处的哈希取模对不上，平铺时会出现一条硬边。
 */
function tileableFractalNoise(
  u: number,
  v: number,
  basePeriod: number,
  octaves: number,
  resolution: number,
  seed: number,
): number {
  let amplitude = 1;
  let total = 0;
  let normalization = 0;
  let period = basePeriod;

  for (let octave = 0; octave < octaves; octave += 1) {
    total += tileableValueNoise(u * period, v * period, period, seed + octave * 0x85eb_ca6b)
      * amplitude;
    normalization += amplitude;
    amplitude *= 0.5;
    const nextPeriod = period * 2;
    if (nextPeriod > resolution) break;
    period = nextPeriod;
  }

  return total / Math.max(normalization, 0.0001);
}

/** 在 `period × period` 的整数栅格上做值噪声，格点索引取模因此左右上下无缝。 */
function tileableValueNoise(x: number, y: number, period: number, seed: number): number {
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  const localX = x - cellX;
  const localY = y - cellY;
  const weightX = localX * localX * (3 - 2 * localX);
  const weightY = localY * localY * (3 - 2 * localY);
  const lowerLeft = latticeHash(cellX, cellY, period, seed);
  const lowerRight = latticeHash(cellX + 1, cellY, period, seed);
  const upperLeft = latticeHash(cellX, cellY + 1, period, seed);
  const upperRight = latticeHash(cellX + 1, cellY + 1, period, seed);
  const lower = lowerLeft + (lowerRight - lowerLeft) * weightX;
  const upper = upperLeft + (upperRight - upperLeft) * weightX;
  return lower + (upper - lower) * weightY;
}

function latticeHash(x: number, y: number, period: number, seed: number): number {
  const wrappedX = ((x % period) + period) % period;
  const wrappedY = ((y % period) + period) % period;
  let hash = Math.imul(wrappedX, 73_856_093) ^ Math.imul(wrappedY, 19_349_663) ^ seed;
  hash = Math.imul(hash ^ hash >>> 16, 0x45d9_f3b);
  hash = Math.imul(hash ^ hash >>> 16, 0x45d9_f3b);
  return ((hash ^ hash >>> 16) >>> 0) / 4_294_967_296;
}

/** 把配置的栅格数收敛到既能整除贴图、又不小于 2 的取值。 */
function wrappablePeriod(requested: number, resolution: number): number {
  let period = Math.max(2, Math.min(resolution, Math.floor(requested)));
  while (period > 2 && resolution % period !== 0) period -= 1;
  return period;
}

export const GRASS_NOISE_TEXTURE_STATS = {
  size: NOISE_TEXTURE_SIZE,
  seed: NOISE_TEXTURE_SEED,
} as const;
