import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node, deliberately. The engine must evaluate identically in the browser and
    // in the collaboration service; a jsdom environment here would hide a
    // dependency that breaks the server side of that promise.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
