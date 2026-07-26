// ESLint flat config for @nix/web.
//
// Extends the workspace root config (type-checked typescript-eslint plus the
// house rules: no-any, consistent-type-imports, explicit module boundary
// types, no stray console) and layers on the two browser-side plugins the
// frontend standards require:
//
//   - eslint-plugin-react-hooks at its "recommended-latest" preset, which is
//     the React 19 / React Compiler aware rule set (purity, immutability,
//     set-state-in-effect, preserve-manual-memoization, ...). Those rules are
//     what make "no manual useMemo/useCallback without a measured reason"
//     safe to follow.
//   - eslint-plugin-jsx-a11y, so accessibility regressions fail the build
//     instead of waiting for an axe run.
//
// The root config already handles plain .js files (it disables type-checked
// rules for them), so this file adds no .js block of its own.
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import rootConfig from '../../eslint.config.js';

export default tseslint.config(
  ...rootConfig,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  // `configs.flat` holds the flat-config variants; `configs['recommended-latest']`
  // is still the legacy eslintrc shape and ESLint 9 rejects it.
  { ...reactHooks.configs.flat['recommended-latest'], files: ['**/*.{ts,tsx}'] },
  { ...jsxA11y.flatConfigs.recommended, files: ['**/*.{ts,tsx}'] },
  {
    // The Vite/Vitest config runs in Node, not the browser.
    files: ['vite.config.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    // Tests deliberately render components that throw, to prove the error
    // boundary recovers; local test helpers carry no public contract.
    files: ['**/*.test.{ts,tsx}', 'src/test/**/*.{ts,tsx}'],
    rules: { '@typescript-eslint/explicit-module-boundary-types': 'off' },
  },
);
