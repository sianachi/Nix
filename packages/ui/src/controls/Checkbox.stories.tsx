import { type Meta, type StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';

import { Checkbox } from './Checkbox';

/**
 * Every state of the toggle, checked and driven from the keyboard where the story can, so axe
 * runs over what a keyboard user actually reaches rather than a screenshot of it.
 */
const meta = {
  title: 'Controls/Checkbox',
  component: Checkbox,
  args: {
    label: 'Insert as inline link',
  },
} satisfies Meta<typeof Checkbox>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Checked: Story = {
  args: { defaultChecked: true },
};

export const Indeterminate: Story = {
  args: { indeterminate: true },
};

export const Disabled: Story = {
  args: { disabled: true },
};

export const DisabledChecked: Story = {
  args: { disabled: true, defaultChecked: true },
};

/** No visible label: the caller has named the control another way, here with `aria-label`. */
export const WithoutVisibleLabel: Story = {
  args: { 'aria-label': 'Select row' },
  render: (args) => <Checkbox aria-label={args['aria-label']} />,
};

export const Focused: Story = {
  play: async ({ canvasElement }) => {
    const checkbox = within(canvasElement).getByRole('checkbox');
    await userEvent.tab();
    await expect(checkbox).toHaveFocus();
  },
};

export const ToggledFromTheKeyboard: Story = {
  play: async ({ canvasElement }) => {
    const checkbox = within(canvasElement).getByRole('checkbox', { name: 'Insert as inline link' });
    await userEvent.tab();
    await userEvent.keyboard(' ');
    await expect(checkbox).toBeChecked();
  },
};

/**
 * The empty box on ink, which is the frame's worst case: it is the only mark in the box, so if the
 * divider hairline did not move with the ground there would be nothing here to see it against.
 */
export const DarkGround: Story = {
  globals: { ground: 'dark' },
};

export const CheckedDark: Story = {
  args: { defaultChecked: true },
  globals: { ground: 'dark' },
};
