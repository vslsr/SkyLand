/**
 * WASM 版本的 chunk 生成后端。
 *
 * 与 chunkGenerator.mjs 里的 JS 实现是同一套算法，接口完全一致，
 * 调用方不需要知道自己拿到的是哪一个。真正的差别在于：
 * 每个 chunk 数万个浮点的矩阵变换与写入全部发生在 wasm 的线性内存里，
 * JS 只在最后做一次切片拷贝，逐顶点的循环不会进入 JS 堆。
 *
 * 模板几何体仍然由 Three.js 在 JS 侧生成后上传，
 * 所以线稿风格的模型定义还留在 src/models/，Rust 不重复实现三角化。
 */

import {
  CHUNK_TEMPLATE_COUNT,
  GROUND_TEMPLATE_INDEX,
  TEMPLATE_ARENA_CAPACITY,
  TEMPLATE_FILL_STRIDE,
} from './chunkGenerator.mjs';

/** 模板注册失败时的错误说明，与 Rust 侧的返回码对应。 */
const REGISTER_ERRORS = {
  '-1': '模板下标越界',
  '-2': '填充顶点超出模板暂存区容量',
  '-3': '轮廓线顶点超出模板暂存区容量',
};

/**
 * 把已经实例化的 wasm 模块包装成 ChunkGenerator。
 * @param {WebAssembly.Instance} instance
 * @returns {import('./chunkGenerator.mjs').ChunkGenerator}
 */
export function createWasmChunkGenerator(instance) {
  const exports = /** @type {Record<string, any>} */ (instance.exports);
  const memory = /** @type {WebAssembly.Memory} */ (exports.memory);

  if (exports.template_count() !== CHUNK_TEMPLATE_COUNT) {
    throw new Error('chunkgen.wasm 的模板数量与 JS 侧不一致，请重新执行 npm run build:wasm');
  }
  if (exports.ground_template_index() !== GROUND_TEMPLATE_INDEX) {
    throw new Error('chunkgen.wasm 的地面模板下标与 JS 侧不一致，请重新执行 npm run build:wasm');
  }

  const arenaPointer = exports.template_arena_ptr();
  const propStride = exports.prop_stride();
  // arena 用简单的顺序分配：模板只在启动时注册一次，不需要回收。
  let arenaOffset = 0;

  /**
   * @param {Float32Array} source
   * @returns {number} 写入位置在 arena 中的 f32 下标
   */
  function uploadToArena(source) {
    if (arenaOffset + source.length > TEMPLATE_ARENA_CAPACITY) {
      throw new Error('模板顶点总量超出 chunkgen.wasm 的暂存区容量');
    }
    const offset = arenaOffset;
    new Float32Array(memory.buffer, arenaPointer, TEMPLATE_ARENA_CAPACITY).set(source, offset);
    arenaOffset += source.length;
    return offset;
  }

  return {
    kind: 'wasm',

    setSeed(seed) {
      exports.set_seed(seed >>> 0);
    },

    registerTemplate(index, template) {
      const fillOffset = uploadToArena(template.fill);
      const lineOffset = uploadToArena(template.line);
      const status = exports.register_template(
        index,
        fillOffset,
        template.fill.length / TEMPLATE_FILL_STRIDE,
        lineOffset,
        template.line.length / 3,
      );
      if (status !== 0) {
        throw new Error(`注册模板失败：${REGISTER_ERRORS[String(status)] ?? status}`);
      }
    },

    buildChunk(chunkX, chunkZ, skipMask) {
      const status = skipMask
        ? exports.build_chunk_masked(chunkX, chunkZ, skipMask.low >>> 0, skipMask.high >>> 0)
        : exports.build_chunk(chunkX, chunkZ);
      if (status !== 0) {
        throw new Error(`chunk ${chunkX}:${chunkZ} 的顶点数超出 chunkgen.wasm 的缓冲区上限`);
      }

      const fillCount = exports.fill_vertex_count();
      const lineCount = exports.line_vertex_count();
      const propCount = exports.prop_count();
      // 视图指向 wasm 内存，下一次 build_chunk 就会被覆盖，所以必须切片拷贝出来。
      const buffer = memory.buffer;

      return {
        fillPositions: new Float32Array(buffer, exports.fill_position_ptr(), fillCount * 3).slice(),
        fillNormals: new Float32Array(buffer, exports.fill_normal_ptr(), fillCount * 3).slice(),
        fillTints: new Float32Array(buffer, exports.fill_tint_ptr(), fillCount * 3).slice(),
        linePositions: new Float32Array(buffer, exports.line_position_ptr(), lineCount * 3).slice(),
        props: new Int32Array(buffer, exports.prop_ptr(), propCount * propStride).slice(),
        propCount,
      };
    },
  };
}

/**
 * 从 wasm 字节实例化一个生成后端。
 * @param {BufferSource} bytes
 * @returns {Promise<import('./chunkGenerator.mjs').ChunkGenerator>}
 */
export async function instantiateChunkGenerator(bytes) {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return createWasmChunkGenerator(instance);
}
