import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    // Some wallet SDKs are still authored for Node and reference these.
    global: 'globalThis',
    'process.env': {},
  },
  build: {
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
  server: {
    port: 8000,
    // Mini apps are opened through a tunnel (World App / MiniPay / LINE cannot
    // reach localhost), so the dev server must accept whatever host it is given.
    allowedHosts: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
});
