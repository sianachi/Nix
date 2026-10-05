import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: { NODE_ENV: 'test' },
    include: ['src/**/*.test.ts'],
    // The database tests share one Postgres and one schema, so they run one file at a time.
    // Parallel files would interleave transactions on the same rows and turn a real
    // isolation failure into a flake nobody trusts.
    fileParallelism: false,
  },
});
