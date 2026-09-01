import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
  plugins: [wasm()],
  build: {
    // chunkgen.wasm 只有几 KB，会被默认的内联阈值转成 base64 塞进 JS。
    // 保持它是独立文件：体积不再被 base64 放大三分之一，浏览器也能单独缓存。
    assetsInlineLimit: (filePath) => (filePath.endsWith('.wasm') ? false : undefined),
  },
  server: {
    host: '0.0.0.0',
    port: 5180,
    strictPort: true,
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
  },
});
