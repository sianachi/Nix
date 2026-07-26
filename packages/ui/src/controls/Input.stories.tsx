import { type Meta, type StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';

import { Input } from './Input';

/**
 * Every tone and every state of the text field.
 *
 * Focus is exercised with real input rather than faked with a class, so what the story shows is
 * what a keyboard user gets; axe runs over each of them.
 */
const meta = {
  title: 'Controls/Input',
  component: Input,
  args: {
    'aria-label': 'Note title',
    placeholder: 'Untitled note',
  },
  argTypes: {
    tone: { control: 'inline-radio', options: ['default', 'plain'] },
    disabled: { control: 'boolean' },
  },
} satisfies Meta<typeof Input>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithValue: Story = {
  args: { defaultValue: 'Quarterly plan' },
};

/** For a field inside an already-framed surface, where a second hairline would read as a rule. */
export const Plain: Story = {
  args: { tone: 'plain', defaultValue: 'Quarterly plan' },
};

export const Focused: Story = {
  play: async ({ canvasElement }) => {
    const input = within(canvasElement).getByRole('textbox');
    await userEvent.click(input);
    await expect(input).toHaveFocus();
  },
};

export const Invalid: Story = {
  args: { 'aria-invalid': true, defaultValue: '' },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('textbox')).toBeInvalid();
  },
};

export const Disabled: Story = {
  args: { disabled: true, defaultValue: 'Quarterly plan' },
};

export const ReadOnly: Story = {
  args: { readOnly: true, defaultValue: 'Quarterly plan' },
};
