import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    // The test suites are Node-compatible and stub browser globals when needed.
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
});
