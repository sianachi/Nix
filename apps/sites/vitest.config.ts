import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: { NODE_ENV: 'test' },
    include: ['src/**/*.test.ts'],
    // A build renders the whole fixture site, link-preview cards included, which takes a few
    // hundred milliseconds alone and several seconds beside other suites on a busy runner.
    testTimeout: 30_000,
  },
});
