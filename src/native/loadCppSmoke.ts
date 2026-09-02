import { createCppSmoke } from '../../shared/native/index.mjs';
import type { CppSmoke } from '../../shared/native/cppSmoke.mjs';

/**
 * WASM 产物的地址。写成 new URL(..., import.meta.url) 与 chunkgen 一致：
 * Vite 在开发时直接服务、构建时作为资源产出，不需要额外的插件或复制步骤。
 */
const WASM_URL = new URL('../../shared/native/wasm/cppsmoke.wasm', import.meta.url);

/** 编译只做一次；这个模块没有实例状态，所以实例也可以只做一次。 */
let loaded: Promise<CppSmoke | undefined> | undefined;

async function compileCppSmoke(): Promise<CppSmoke | undefined> {
  try {
    const response = await fetch(WASM_URL);
    if (!response.ok) throw new Error(`cppsmoke.wasm 请求失败：HTTP ${response.status}`);
    const module = await WebAssembly.compile(await response.arrayBuffer());
    return createCppSmoke(await WebAssembly.instantiate(module, {}));
  } catch (error) {
    console.warn('[native] C++ 冒烟模块不可用', error);
    return undefined;
  }
}

/**
 * 取得 C++ 冒烟模块，失败返回 undefined 而不是抛出。
 *
 * 它只是一条工具链的自检，没有任何玩法依赖它；
 * 没有理由因为一个 242 字节的诊断文件加载失败就让玩家进不去游戏。
 */
export function loadCppSmoke(): Promise<CppSmoke | undefined> {
  loaded ??= compileCppSmoke();
  return loaded;
}

/**
 * 跑一次冒烟断言，返回给调试菜单直接显示的一行结论。
 *
 * 断言故意写死在 JS 侧而不是 C++ 侧：要验证的是「跨语言边界传参与返回值正确」，
 * 让 C++ 自己判断自己等于没验证。
 */
export async function runCppSmoke(): Promise<string> {
  const smoke = await loadCppSmoke();
  if (!smoke) return 'C++ 模块未加载：产物缺失或实例化失败，详见控制台。';

  const sum = smoke.add(2, 3);
  if (sum !== 5) return `C++ add(2, 3) 返回 ${sum}，期望 5 —— 产物与源码不一致。`;

  return `链路正常 · add(2, 3) = ${sum} · 契约版本 v${smoke.abiVersion}`;
}
