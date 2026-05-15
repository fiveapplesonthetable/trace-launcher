import {defineConfig} from 'vite';

// The SPA is a static bundle; in dev, API calls are proxied to the Node server
// started by `npm run dev:api`. In production the same Node server serves the
// built assets out of dist/, so the app is always same-origin.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:9002',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  css: {
    preprocessorOptions: {
      scss: {api: 'modern-compiler'},
    },
  },
});
