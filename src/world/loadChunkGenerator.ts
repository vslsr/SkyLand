import { createJavaScriptChunkGenerator } from '../../shared/world/chunkGenerator.mjs';
import type { ChunkGenerator } from '../../shared/world/chunkGenerator.mjs';
import { instantiateChunkGenerator } from '../../shared/world/chunkGeneratorWasm.mjs';

/**
 * WASM 产物的地址。写成 new URL(..., import.meta.url) 是为了让 Vite
 * 在开发时直接服务、在构建时作为资源产出，不需要额外的插件或复制步骤。
 */
const WASM_URL = new URL('../../shared/world/wasm/chunkgen.wasm', import.meta.url);

/** 用 ?chunkgen=js 打开页面即可强制走 JS 后端，方便对照两条路径的表现。 */
function isJavaScriptForced(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('chunkgen') === 'js';
}

/**
 * 取得 chunk 生成后端，优先 WASM。
 *
 * WASM 拿不到时降级到 JS 实现而不是抛错：两者算出的世界完全一致，
 * 差别只是快慢，没有理由因为一个 3 KB 的文件加载失败就让玩家进不去游戏。
 */
export async function loadChunkGenerator(): Promise<ChunkGenerator> {
  if (isJavaScriptForced()) {
    console.info('[world] 已按 ?chunkgen=js 强制使用 JS 生成后端');
    return createJavaScriptChunkGenerator();
  }

  try {
    const response = await fetch(WASM_URL);
    if (!response.ok) throw new Error(`chunkgen.wasm 请求失败：HTTP ${response.status}`);
    return await instantiateChunkGenerator(await response.arrayBuffer());
  } catch (error) {
    console.warn('[world] WASM 生成后端不可用，已降级为 JS 实现', error);
    return createJavaScriptChunkGenerator();
  }
}
