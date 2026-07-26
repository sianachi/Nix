import { defineConfig, mergeConfig } from 'vitest/config';

import viteConfig from './vite.config';

/**
 * Unit and component tests: jsdom, no browser, fast enough to run on every
 * save. Story-level a11y and interaction runs live in
 * vitest.storybook.config.ts, which needs a real browser.
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      name: 'unit',
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}'],
      setupFiles: ['./vitest.setup.ts'],
      css: false,
      restoreMocks: true,
    },
  }),
);
