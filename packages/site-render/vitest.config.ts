import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The golden and CLI tests render whole sites; give them room on a cold machine.
    testTimeout: 30_000,
  },
});
