import * as a11yAddonAnnotations from '@storybook/addon-a11y/preview';
import { setProjectAnnotations } from '@storybook/react-vite';
import { beforeAll } from 'vitest';

import * as projectAnnotations from './preview';

// Give the Vitest run the same preview configuration the browser gets - the
// Tailwind entry, the layout parameter, and the a11y addon's axe pass.
const project = setProjectAnnotations([a11yAddonAnnotations, projectAnnotations]);

beforeAll(project.beforeAll);
