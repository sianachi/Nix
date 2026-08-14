import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: { NODE_ENV: 'test' },
    include: ['src/**/*.test.ts'],
    // No fileParallelism override, deliberately: this service holds no database, so its tests share
    // no state and there is nothing for parallel files to interleave.
  },
});
