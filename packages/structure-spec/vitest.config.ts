import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node, deliberately. This package depends on no browser API and must stay usable from
    // nixctl and the worker, not only from the web bundle.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
