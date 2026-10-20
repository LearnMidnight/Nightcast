import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 15 * 60_000,
    // The end-to-end tests share one network and run in order.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
