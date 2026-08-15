import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: resolve(import.meta.dirname, 'web'),
  base: '/',
  plugins: [tailwindcss(), react()],
  build: {
    target: 'es2022',
    outDir: resolve(import.meta.dirname, 'dist/web'),
    emptyOutDir: true,
    assetsDir: 'assets',
    sourcemap: true,
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': 'http://127.0.0.1:8420',
      '/mcp': 'http://127.0.0.1:8420',
    },
  },
});
