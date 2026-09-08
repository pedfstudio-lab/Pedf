import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Root-domain hosting: keep asset URLs absolute for deep links such as /app/.
  base: '/',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // pdf.js ships an ES-module worker; keep worker output as ESM.
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
