import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    server: {
      deps: {
        external: ['node:sqlite'],
      },
    },
  },
  ssr: {
    external: ['node:sqlite'],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
