import { type Meta, type StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';

import { Button } from './Button';
import { Input } from './Input';
import { Popover } from './Popover';

/** A small non-modal panel of controls beside its trigger, and a bottom sheet on a phone. */
const meta = {
  title: 'Controls/Popover',
  component: Popover,
  args: {
    label: 'Filter',
    trigger: (trigger) => (
      <Button variant="secondary" {...trigger}>
        Filter
      </Button>
    ),
    children: ({ close }) => (
      <>
        <Input aria-label="Contains" placeholder="Contains" />
        <Button onClick={close}>Apply</Button>
      </>
    ),
  },
} satisfies Meta<typeof Popover>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Closed: Story = {};

export const Open: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: 'Filter' }));
    await expect(canvas.getByRole('dialog', { name: 'Filter' })).toBeVisible();
  },
};
