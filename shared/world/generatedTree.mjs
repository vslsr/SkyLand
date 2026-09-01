import {
  PROP_BUFFER_LENGTH,
  PROP_FIELD,
  PROP_STRIDE,
  generateChunkProps,
} from './chunkContent.mjs';
import {
  MAXIMUM_PROPS_PER_CHUNK,
  PROP_KIND,
  isChunkInsideWorld,
} from './worldConfig.mjs';

const GENERATED_TREE_ID_PATTERN = /^tree:(-?\d+):(-?\d+):(\d+)$/;

/** @typedef {{ low: number, high: number }} PropSkipMask */

/** @returns {PropSkipMask} */
export function createPropSkipMask(low = 0, high = 0) {
  return { low: Number(low) >>> 0, high: Number(high) >>> 0 };
}

/** @param {number} propIndex @param {PropSkipMask | undefined} mask */
export function isPropSkipped(propIndex, mask) {
  if (!mask || !Number.isInteger(propIndex) || propIndex < 0 || propIndex >= 64) return false;
  const bits = propIndex < 32 ? mask.low : mask.high;
  return ((bits >>> (propIndex & 31)) & 1) === 1;
}

/**
 * 返回一份新掩码；调用方可以通过引用是否变化判断状态有没有改变。
 * @param {PropSkipMask | undefined} mask
 * @param {number} propIndex
 * @param {boolean} skipped
 * @returns {PropSkipMask}
 */
export function setPropSkipped(mask, propIndex, skipped) {
  if (!Number.isInteger(propIndex) || propIndex < 0 || propIndex >= 64) {
    throw new RangeError(`propIndex 超出跳过掩码范围：${propIndex}`);
  }
  const current = createPropSkipMask(mask?.low, mask?.high);
  const bit = (1 << (propIndex & 31)) >>> 0;
  const field = propIndex < 32 ? 'low' : 'high';
  current[field] = skipped
    ? (current[field] | bit) >>> 0
    : (current[field] & ~bit) >>> 0;
  return current;
}

export function formatGeneratedTreeId(chunkX, chunkZ, propIndex) {
  if (!Number.isInteger(chunkX) || !Number.isInteger(chunkZ) || !isChunkInsideWorld(chunkX, chunkZ)) {
    throw new RangeError('树的 chunk 坐标超出世界范围');
  }
  if (!Number.isInteger(propIndex) || propIndex < 0 || propIndex >= MAXIMUM_PROPS_PER_CHUNK) {
    throw new RangeError('树的 propIndex 超出范围');
  }
  return `tree:${chunkX}:${chunkZ}:${propIndex}`;
}

/**
 * @param {unknown} value
 * @returns {{ chunkX: number, chunkZ: number, propIndex: number } | undefined}
 */
export function parseGeneratedTreeId(value) {
  const match = GENERATED_TREE_ID_PATTERN.exec(String(value ?? ''));
  if (!match) return undefined;
  const chunkX = Number(match[1]);
  const chunkZ = Number(match[2]);
  const propIndex = Number(match[3]);
  if (
    !isChunkInsideWorld(chunkX, chunkZ)
    || !Number.isInteger(propIndex)
    || propIndex < 0
    || propIndex >= MAXIMUM_PROPS_PER_CHUNK
  ) return undefined;
  return { chunkX, chunkZ, propIndex };
}

/**
 * 从确定性放置结果解析一棵树。服务端可用它校验自描述 id，客户端可用它构造
 * 不带网格的派生 Actor。返回 undefined 表示该下标不是一棵真实生成的树。
 *
 * @param {number} worldSeed
 * @param {number} chunkX
 * @param {number} chunkZ
 * @param {number} propIndex
 * @param {Int32Array} [buffer]
 */
export function deriveGeneratedTree(worldSeed, chunkX, chunkZ, propIndex, buffer) {
  if (!Number.isInteger(chunkX) || !Number.isInteger(chunkZ) || !isChunkInsideWorld(chunkX, chunkZ)) {
    return undefined;
  }
  if (!Number.isInteger(propIndex) || propIndex < 0 || propIndex >= MAXIMUM_PROPS_PER_CHUNK) {
    return undefined;
  }
  const props = buffer ?? new Int32Array(PROP_BUFFER_LENGTH);
  const count = generateChunkProps(worldSeed, chunkX, chunkZ, props);
  if (propIndex >= count) return undefined;
  const offset = propIndex * PROP_STRIDE;
  if (props[offset + PROP_FIELD.KIND] !== PROP_KIND.TREE) return undefined;
  return {
    id: formatGeneratedTreeId(chunkX, chunkZ, propIndex),
    chunkX,
    chunkZ,
    propIndex,
    x: props[offset + PROP_FIELD.X_MM] / 1000,
    z: props[offset + PROP_FIELD.Z_MM] / 1000,
    yaw: props[offset + PROP_FIELD.ROTATION_MRAD] / 1000,
    scale: props[offset + PROP_FIELD.SCALE_THOUSANDTHS] / 1000,
  };
}
