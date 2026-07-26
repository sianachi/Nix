import { type Meta, type StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { Field } from './Field';
import { Input } from './Input';

/**
 * A label, a control, and the text that belongs to it - in every combination the wiring has to
 * get right.
 *
 * The point of the component is that the four identifiers connecting those parts cannot be
 * assembled wrongly, so each story asserts the connection rather than the appearance.
 */
const meta = {
  title: 'Controls/Field',
  component: Field,
  args: {
    label: 'Note title',
    children: (control) => <Input {...control} placeholder="Untitled note" />,
  },
} satisfies Meta<typeof Field>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole('textbox', { name: 'Note title' }),
    ).toBeInTheDocument();
  },
};

export const WithHint: Story = {
  args: { hint: 'Shown in the tree and in search results.' },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole('textbox', { name: 'Note title' }),
    ).toHaveAccessibleDescription('Shown in the tree and in search results.');
  },
};

export const Required: Story = {
  args: {
    required: true,
    children: (control) => <Input {...control} required placeholder="Untitled note" />,
  },
};

/** The error replaces the hint rather than joining it. */
export const Invalid: Story = {
  args: {
    hint: 'Shown in the tree and in search results.',
    error: 'A title is required.',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('textbox', { name: 'Note title' })).toBeInvalid();
    await expect(canvas.queryByText('Shown in the tree and in search results.')).toBeNull();
  },
};

export const Disabled: Story = {
  args: {
    hint: 'This workspace is read only.',
    children: (control) => <Input {...control} disabled defaultValue="Quarterly plan" />,
  },
};
