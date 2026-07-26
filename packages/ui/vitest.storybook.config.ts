import { fileURLToPath } from 'node:url';

import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { defineConfig, mergeConfig } from 'vitest/config';

import viteConfig from './vite.config';

const storybookDir = fileURLToPath(new URL('.storybook', import.meta.url));

/**
 * The story-level run: every story is rendered in a real browser, its `play`
 * function executed, and axe run over the result. `a11y.test: 'error'` in
 * .storybook/preview.ts turns any violation into a failing test, so this is
 * the gate engineering plan section 8.5 calls "Storybook test-runner + axe".
 *
 * Storybook 9 ships this as @storybook/addon-vitest, which supersedes the
 * standalone @storybook/test-runner: it needs no separately served Storybook
 * and reuses the Vite pipeline the stories already compile through.
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    plugins: [storybookTest({ configDir: storybookDir })],
    test: {
      name: 'storybook',
      setupFiles: ['./.storybook/vitest.setup.ts'],
      browser: {
        enabled: true,
        headless: true,
        provider: 'playwright',
        instances: [{ browser: 'chromium' }],
      },
    },
  }),
);
