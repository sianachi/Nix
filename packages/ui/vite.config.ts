import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Shared Vite configuration. Storybook's react-vite framework loads this file
 * and merges it (detecting the React plugin already present rather than adding
 * a second one), and both Vitest configs re-use the same plugin list, so a
 * component compiles the same way in the browser, in Storybook and in a test.
 *
 * @nix/ui builds no bundle of its own: it is consumed as TypeScript source by
 * the apps, which compile it with their own Vite pipeline.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
});
