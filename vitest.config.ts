import { defineConfig } from 'vitest/config';

export default defineConfig({
  ssr: {
    external: ['node:sqlite'],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    globals: false,
    passWithNoTests: false,
    server: {
      deps: { external: [/node:/] },
    },
  },
});
