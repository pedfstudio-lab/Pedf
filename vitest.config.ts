import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    // Coordinate-transform tests are pure math — no DOM needed.
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
});
