// packages/ui ESLint config. Extends the repo-root flat config (type-checked,
// strict) and adds the two plugins this package needs and the root cannot
// carry: react-hooks (rules of hooks) and jsx-a11y (the accessibility floor
// the component library is responsible for).
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';

import rootConfig from '../../eslint.config.js';

export default [
  ...rootConfig,
  {
    files: ['**/*.tsx'],
    ...jsxA11y.flatConfigs.strict,
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    ...reactHooks.configs.flat.recommended,
  },
  {
    files: ['**/*.stories.tsx', '**/*.test.tsx', '**/*.test.ts'],
    rules: {
      // Story and test objects are inferred; annotating every export's return
      // type adds noise without adding safety.
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
];
