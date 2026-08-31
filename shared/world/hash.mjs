/**
 * 世界生成用的整数哈希与值噪声。
 *
 * 这里刻意不使用任何浮点运算：所有中间结果都是 32 位整数，
 * JS 的 Math.imul / >>> 与 Rust 的 wrapping_mul / >> 在位级完全等价，
 * 所以同一个种子在浏览器、房间进程和 WASM 里得到的世界必然一致。
 * 一旦这里引入浮点，跨端就可能出现「你看到树、我看不到树」的分裂。
 */

/**
 * 四路混合的 32 位哈希，返回 [0, 2³²) 的无符号整数。
 * @param {number} seed
 * @param {number} a
 * @param {number} b
 * @param {number} c
 * @returns {number}
 */
export function hash32(seed, a, b, c) {
  let h = (seed ^ 0x9e3779b9) | 0;
  h = Math.imul(h ^ (a | 0), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ (b | 0), 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h ^ (c | 0), 0x27d4eb2f);
  h ^= h >>> 15;
  return h >>> 0;
}

/**
 * 把哈希值映射到 [minimum, maximum] 闭区间的整数。
 * @param {number} hash 无符号哈希值
 * @param {number} minimum
 * @param {number} maximum
 * @returns {number}
 */
export function hashToRange(hash, minimum, maximum) {
  const span = maximum - minimum + 1;
  return minimum + ((hash >>> 0) % span);
}

/** 值噪声格点的取值上限，噪声结果落在 [0, NOISE_SCALE]。 */
export const NOISE_SCALE = 255;

/**
 * 格点上的稳定取值，[0, NOISE_SCALE]。
 * @param {number} seed
 * @param {number} latticeX
 * @param {number} latticeY
 * @returns {number}
 */
function latticeValue(seed, latticeX, latticeY) {
  return hash32(seed, latticeX, latticeY, 0x51ed270b) & NOISE_SCALE;
}

/**
 * 定点 smoothstep：把 [0, size) 的位置映射成同区间内的平滑权重，
 * 使相邻格之间的过渡没有折线感。
 * @param {number} value
 * @param {number} size
 * @returns {number}
 */
function smoothWeight(value, size) {
  const squared = value * value;
  return ((3 * squared * size - 2 * squared * value) / (size * size)) | 0;
}

/**
 * 整数双线性值噪声。
 *
 * shift 决定特征尺度：格点间距为 2^shift 个输入单位，
 * 为避免中间结果溢出 32 位，shift 不要超过 6。
 * @param {number} seed
 * @param {number} x
 * @param {number} y
 * @param {number} shift
 * @returns {number} [0, NOISE_SCALE] 的整数
 */
export function valueNoise(seed, x, y, shift) {
  const size = 1 << shift;
  const latticeX = x >> shift;
  const latticeY = y >> shift;
  const weightX = smoothWeight(x - (latticeX << shift), size);
  const weightY = smoothWeight(y - (latticeY << shift), size);

  const corner00 = latticeValue(seed, latticeX, latticeY);
  const corner10 = latticeValue(seed, latticeX + 1, latticeY);
  const corner01 = latticeValue(seed, latticeX, latticeY + 1);
  const corner11 = latticeValue(seed, latticeX + 1, latticeY + 1);

  const top = ((corner00 * (size - weightX) + corner10 * weightX) / size) | 0;
  const bottom = ((corner01 * (size - weightX) + corner11 * weightX) / size) | 0;
  return ((top * (size - weightY) + bottom * weightY) / size) | 0;
}
