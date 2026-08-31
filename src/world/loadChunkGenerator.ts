import { createJavaScriptChunkGenerator } from '../../shared/world/chunkGenerator.mjs';
import type { ChunkGenerator } from '../../shared/world/chunkGenerator.mjs';
import { createWasmChunkGenerator } from '../../shared/world/chunkGeneratorWasm.mjs';

/**
 * WASM 产物的地址。写成 new URL(..., import.meta.url) 是为了让 Vite
 * 在开发时直接服务、在构建时作为资源产出，不需要额外的插件或复制步骤。
 */
const WASM_URL = new URL('../../shared/world/wasm/chunkgen.wasm', import.meta.url);

/**
 * 编译只做一次，实例化每个场景一次。
 *
 * 模板是注册进实例的线性内存的，不同场景的配色不同，所以不能共用一个实例；
 * 但编译结果可以共用，实例化一个 3 KB 的模块几乎不花时间。
 */
let compiledModule: Promise<WebAssembly.Module | undefined> | undefined;

/** 用 ?chunkgen=js 打开页面即可强制走 JS 后端，方便对照两条路径的表现。 */
function isJavaScriptForced(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('chunkgen') === 'js';
}

async function compileChunkGenerator(): Promise<WebAssembly.Module | undefined> {
  try {
    const response = await fetch(WASM_URL);
    if (!response.ok) throw new Error(`chunkgen.wasm 请求失败：HTTP ${response.status}`);
    return await WebAssembly.compile(await response.arrayBuffer());
  } catch (error) {
    console.warn('[world] WASM 生成后端不可用，已降级为 JS 实现', error);
    return undefined;
  }
}

/**
 * 为一个场景取得独立的 chunk 生成后端，优先 WASM。
 *
 * WASM 拿不到时降级到 JS 实现而不是抛错：两者算出的世界完全一致，
 * 差别只是快慢，没有理由因为一个 3 KB 的文件加载失败就让玩家进不去游戏。
 */
export async function createChunkGenerator(): Promise<ChunkGenerator> {
  if (isJavaScriptForced()) {
    console.info('[world] 已按 ?chunkgen=js 强制使用 JS 生成后端');
    return createJavaScriptChunkGenerator();
  }

  compiledModule ??= compileChunkGenerator();
  const module = await compiledModule;
  if (!module) return createJavaScriptChunkGenerator();

  try {
    return createWasmChunkGenerator(await WebAssembly.instantiate(module, {}));
  } catch (error) {
    console.warn('[world] WASM 实例化失败，已降级为 JS 实现', error);
    return createJavaScriptChunkGenerator();
  }
}
