import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node, deliberately. An archive is written by a service, never by a browser, and the zip
    // machinery underneath works on byte arrays rather than anything a DOM provides.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
