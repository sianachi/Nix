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

      // Not the 5000 default, for the same reason as apps/web's own (see its vite.config.ts).
      // Measured with `vitest run --reporter=json` on an otherwise idle 10-core machine: the
      // slowest tests are each file's first, paying module load and first jsdom render - 2133ms
      // for Card's heading, 2067ms for Listbox, 1930ms for Text - about 43% of the default
      // before any contention. A full workspace check running this suite beside the web suite
      // and a .NET build pushed seven of them past 5000ms; each passed on its own rerun. 15s
      // keeps headroom for a busy runner without letting a genuinely hung test sit for a minute.
      testTimeout: 15_000,
    },
  }),
);
