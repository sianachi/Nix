import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node, deliberately. The schema has to be constructible without a DOM,
    // because the collaboration service builds it in Node to validate updates.
    // A jsdom environment here would hide a dependency that breaks there.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
