/**
 * native/cppsmoke 产物的 JS 门面。
 *
 * 产物是 -sSTANDALONE_WASM 编出来的自包含模块：import 段为空，
 * 所以实例化方式与 chunkgen.wasm 完全一致——WebAssembly.instantiate(bytes, {})，
 * 不需要 Emscripten 的 JS 胶水，也就没有一份生成代码要签进仓库。
 *
 * 门面本身没有业务价值，它只把「链路是通的」这件事表达成一个可断言的对象。
 */

/**
 * 期望的冒烟契约版本，必须与 native/cppsmoke/src/smoke.cpp 的
 * smoke_abi_version() 一致。对不上说明签入的 .wasm 落后于 C++ 源码。
 */
export const CPP_SMOKE_ABI_VERSION = 1;

/**
 * @typedef {object} CppSmoke
 * @property {number} abiVersion 产物报告的契约版本
 * @property {(a: number, b: number) => number} add C++ 侧的整数加法
 */

/**
 * 把已经实例化的 wasm 模块包装成 CppSmoke。
 * @param {WebAssembly.Instance} instance
 * @returns {CppSmoke}
 */
export function createCppSmoke(instance) {
  const exports = /** @type {Record<string, any>} */ (instance.exports);

  if (typeof exports.add !== 'function' || typeof exports.smoke_abi_version !== 'function') {
    throw new Error('cppsmoke.wasm 缺少预期导出，请重新执行 npm run build:cpp-wasm');
  }

  const abiVersion = exports.smoke_abi_version();
  if (abiVersion !== CPP_SMOKE_ABI_VERSION) {
    throw new Error(
      `cppsmoke.wasm 的契约版本是 ${abiVersion}，JS 侧期望 ${CPP_SMOKE_ABI_VERSION}，`
      + '请重新执行 npm run build:cpp-wasm',
    );
  }

  return {
    abiVersion,
    // wasm 的 i32 参数由引擎自行截断，这里只做取整以免传入小数时静默丢精度。
    add: (a, b) => exports.add(a | 0, b | 0),
  };
}

/**
 * 从 wasm 字节实例化一个冒烟门面。
 * @param {BufferSource} bytes
 * @returns {Promise<CppSmoke>}
 */
export async function instantiateCppSmoke(bytes) {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return createCppSmoke(instance);
}
