import { type StorybookConfig } from '@storybook/react-vite';

/**
 * Storybook is the component library's contract: every component ships
 * stories for all of its variants and all of its interaction states, and
 * @storybook/addon-a11y runs axe over each one.
 *
 * Vite configuration (the React plugin and @tailwindcss/vite) comes from the
 * package's own vite.config.ts, which Storybook's react-vite framework loads
 * and merges - the same config Vitest uses, so a story renders identically in
 * the browser and in a test.
 */
const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)', '../../../apps/web/src/pets/*.stories.tsx'],
  staticDirs: [{ from: '../../../apps/web/public/pets', to: '/pets' }],
  addons: ['@storybook/addon-a11y', '@storybook/addon-docs', '@storybook/addon-vitest'],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
};

export default config;
