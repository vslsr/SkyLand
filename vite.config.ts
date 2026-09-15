import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

// 跨源隔离（引擎迁移路线图 第 0 步）：SharedArrayBuffer 与 Emscripten pthreads
// 只在 crossOriginIsolated 的文档里可用。dev 与 preview 必须和 server/http/
// crossOriginIsolation.mjs 发同一组头，否则本地开发拿不到线上的能力集。
const CROSS_ORIGIN_ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export default defineConfig({
  plugins: [wasm()],
  build: {
    // 两个页面入口：游戏本体与运维后台。后台是独立文档，不与游戏共用运行时。
    rollupOptions: {
      // 相对项目根目录写：这里不引 node:path，仓库没装 @types/node，tsc 会当场报错。
      input: { main: 'index.html', admin: 'admin.html' },
    },
    // chunkgen.wasm 只有几 KB，会被默认的内联阈值转成 base64 塞进 JS。
    // 保持它是独立文件：体积不再被 base64 放大三分之一，浏览器也能单独缓存。
    assetsInlineLimit: (filePath) => (filePath.endsWith('.wasm') ? false : undefined),
  },
  server: {
    host: '0.0.0.0',
    port: 5180,
    strictPort: true,
    headers: CROSS_ORIGIN_ISOLATION_HEADERS,
    proxy: {
      '/api': 'http://127.0.0.1:3090',
      '/ws': {
        target: 'ws://127.0.0.1:3090',
        ws: true,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4180,
    strictPort: true,
    headers: CROSS_ORIGIN_ISOLATION_HEADERS,
  },
});
