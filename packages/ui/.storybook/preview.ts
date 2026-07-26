import { type Preview } from '@storybook/react-vite';

import './tailwind.css';

/**
 * `a11y.test: 'error'` makes an axe finding fail the story under the Vitest
 * addon, so an inaccessible component cannot merge green. Backgrounds are
 * disabled because the ground is not a choice: it is `--color-bg`, set on the
 * body by the Tailwind entry.
 */
const preview: Preview = {
  parameters: {
    layout: 'centered',
    a11y: { test: 'error' },
    backgrounds: { disable: true },
    controls: { expanded: true, matchers: { color: /(background|color)$/i } },
  },
};

export default preview;
