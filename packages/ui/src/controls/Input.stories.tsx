import { type Meta, type StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';

import { Button } from './Button';
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

export const NarrowLayout: Story = {
  args: { defaultValue: 'A longer note title on a small screen' },
  render: (args) => (
    <div className="flex w-64 max-w-full items-start gap-2">
      <Input {...args} />
      <Button>Save</Button>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const input = within(canvasElement).getByRole('textbox');
    const button = within(canvasElement).getByRole('button', { name: 'Save' });
    await userEvent.click(input);
    await expect(input).toHaveFocus();
    await expect(input.getBoundingClientRect().right).toBeLessThanOrEqual(
      button.getBoundingClientRect().left,
    );
    const typeStep = matchMedia('(any-pointer: coarse)').matches ? '--text-lg' : '--text-md';
    await expect(getComputedStyle(input).fontSize).toBe(
      getComputedStyle(document.documentElement).getPropertyValue(typeStep).trim(),
    );
  },
};

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

/**
 * The empty field on ink, which is the placeholder's worst case: it is the only
 * thing in the box, so if the quiet step were chosen against paper there would
 * be nothing legible here at all.
 */
export const DarkGround: Story = {
  globals: { ground: 'dark' },
};

/** A value and the invalid frame on ink. The frame is `--color-foreground`, so it inverts. */
export const InvalidDark: Story = {
  args: { 'aria-invalid': true, defaultValue: 'Quarterly plan' },
  globals: { ground: 'dark' },
};
