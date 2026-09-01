import { hash32 } from './hash.mjs';
import { toWorldSeed } from './worldConfig.mjs';

export const WORLD_PROP_VARIANT_MAXIMUM_COUNT = 16;
export const WORLD_PROP_VARIANT_WEIGHT_MAXIMUM = 1000;

// 变体只选择同一条放置记录由哪个 Actor 原型承载，不改变 kind、位置、缩放或
// chunk 顶点，所以它不属于 JS/Rust 放置 parity，也不进入 WASM ABI。
const WORLD_PROP_VARIANT_SALT = 0x4b1d5a77;
const WORLD_PROP_KIND_SALT = 0x6d2b79f5;

/**
 * 从场景配置的带权列表里确定性选择一个世界物件原型。
 *
 * 服务端和客户端都调用这一个函数；输入只来自房间种子与放置记录地址，结果不需要
 * 复制。数组顺序是配置契约的一部分，同权重时每一项占同样大的哈希区间。
 *
 * @template {{ weight: number }} T
 * @param {number} worldSeed
 * @param {number} kind
 * @param {number} chunkX
 * @param {number} chunkZ
 * @param {number} propIndex
 * @param {ReadonlyArray<T>} variants
 * @returns {T | undefined}
 */
export function selectWorldPropVariant(
  worldSeed,
  kind,
  chunkX,
  chunkZ,
  propIndex,
  variants,
) {
  if (!Array.isArray(variants) || variants.length === 0) return undefined;
  let totalWeight = 0;
  for (const variant of variants) {
    if (!Number.isInteger(variant?.weight) || variant.weight <= 0) return undefined;
    totalWeight += variant.weight;
  }
  if (!Number.isSafeInteger(totalWeight) || totalWeight <= 0) return undefined;

  const address = (propIndex ^ Math.imul((kind | 0) + 1, WORLD_PROP_KIND_SALT)) | 0;
  let ticket = hash32(
    toWorldSeed(worldSeed) ^ WORLD_PROP_VARIANT_SALT,
    chunkX,
    chunkZ,
    address,
  ) % totalWeight;
  for (const variant of variants) {
    if (ticket < variant.weight) return variant;
    ticket -= variant.weight;
  }
  return variants.at(-1);
}
