import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node, deliberately. The executor runs from the worker, nixctl and the web bundle
    // alike; a jsdom environment here would hide a dependency that breaks a non-browser
    // caller.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
