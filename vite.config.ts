import { defineConfig } from 'vite';

export default defineConfig({
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
