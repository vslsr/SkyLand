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

/**
 * PROP_KIND 数值与 Actor id 里出现的名字之间的映射。
 *
 * 名字写进 Actor id，也就写进了网络消息，所以它是对外契约的一部分：可以新增，
 * 不能改名。数值本身写进放置记录，同样不能重排——两者一起构成「这一格是什么」
 * 的稳定表示。
 */
export const PROP_KIND_NAME = Object.freeze({
  [PROP_KIND.TREE]: 'tree',
  [PROP_KIND.GRASS]: 'grass',
  [PROP_KIND.ROCK]: 'rock',
});

export const PROP_KIND_BY_NAME = Object.freeze(
  Object.fromEntries(Object.entries(PROP_KIND_NAME).map(([kind, name]) => [name, Number(kind)])),
);

const GENERATED_PROP_ID_PATTERN = /^prop:([a-z]+):(-?\d+):(-?\d+):(\d+)$/;

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

/**
 * 生成物件的自描述 id：`prop:<种类>:<chunkX>:<chunkZ>:<放置下标>`。
 *
 * 种类是冗余的——(chunkX, chunkZ, propIndex) 已经唯一确定了一格。带上它是为了
 * 让「只拿到 id」的一侧（客户端收到偏离态快照，但对应 chunk 还没装载）不用跑一遍
 * 生成器就能挑出原型。冗余不会让客户端说了算：权威侧的 Actor 只可能由服务端从
 * 世界种子推导出来，交互入口再拿 id 里的种类和 Component 对一次，对不上就拒绝。
 *
 * @param {number} kind PROP_KIND 中的一个
 * @param {number} chunkX
 * @param {number} chunkZ
 * @param {number} propIndex
 */
export function formatGeneratedPropId(kind, chunkX, chunkZ, propIndex) {
  const name = PROP_KIND_NAME[kind];
  if (!name) throw new RangeError(`未知的物件种类：${kind}`);
  if (!Number.isInteger(chunkX) || !Number.isInteger(chunkZ) || !isChunkInsideWorld(chunkX, chunkZ)) {
    throw new RangeError('物件的 chunk 坐标超出世界范围');
  }
  if (!Number.isInteger(propIndex) || propIndex < 0 || propIndex >= MAXIMUM_PROPS_PER_CHUNK) {
    throw new RangeError('物件的 propIndex 超出范围');
  }
  return `prop:${name}:${chunkX}:${chunkZ}:${propIndex}`;
}

/**
 * @param {unknown} value
 * @returns {{ kind: number, chunkX: number, chunkZ: number, propIndex: number } | undefined}
 */
export function parseGeneratedPropId(value) {
  const match = GENERATED_PROP_ID_PATTERN.exec(String(value ?? ''));
  if (!match) return undefined;
  const kind = PROP_KIND_BY_NAME[match[1]];
  const chunkX = Number(match[2]);
  const chunkZ = Number(match[3]);
  const propIndex = Number(match[4]);
  if (
    kind === undefined
    || !isChunkInsideWorld(chunkX, chunkZ)
    || !Number.isInteger(propIndex)
    || propIndex < 0
    || propIndex >= MAXIMUM_PROPS_PER_CHUNK
  ) return undefined;
  return { kind, chunkX, chunkZ, propIndex };
}

/**
 * 从确定性放置结果解析一个物件。服务端用它校验自描述 id，客户端用它构造不带
 * 网格的派生 Actor。返回 undefined 表示该下标上没有物件。
 *
 * @param {number} worldSeed
 * @param {number} chunkX
 * @param {number} chunkZ
 * @param {number} propIndex
 * @param {Int32Array} [buffer]
 */
export function deriveGeneratedProp(worldSeed, chunkX, chunkZ, propIndex, buffer) {
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
  const kind = props[offset + PROP_FIELD.KIND];
  if (!PROP_KIND_NAME[kind]) return undefined;
  return {
    id: formatGeneratedPropId(kind, chunkX, chunkZ, propIndex),
    kind,
    chunkX,
    chunkZ,
    propIndex,
    x: props[offset + PROP_FIELD.X_MM] / 1000,
    z: props[offset + PROP_FIELD.Z_MM] / 1000,
    yaw: props[offset + PROP_FIELD.ROTATION_MRAD] / 1000,
    scale: props[offset + PROP_FIELD.SCALE_THOUSANDTHS] / 1000,
  };
}
