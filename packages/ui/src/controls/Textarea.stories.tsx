import { type Meta, type StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';

import { Button } from './Button';
import { Field } from './Field';
import { Textarea } from './Textarea';

/**
 * Every tone and state of the multi-line field.
 *
 * Focus is exercised with real input rather than faked with a class; axe runs over each story.
 */
const meta = {
  title: 'Controls/Textarea',
  component: Textarea,
  args: {
    'aria-label': 'Note body',
    placeholder: 'Write something',
  },
  argTypes: {
    tone: { control: 'inline-radio', options: ['default', 'plain'] },
    resize: { control: 'inline-radio', options: ['none', 'vertical'] },
    autoGrow: { control: 'boolean' },
    disabled: { control: 'boolean' },
  },
} satisfies Meta<typeof Textarea>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const field = within(canvasElement).getByRole('textbox');
    await userEvent.click(field);
    await expect(field).toHaveFocus();
  },
};

export const NarrowLayout: Story = {
  render: (args) => (
    <div className="flex w-64 max-w-full items-start gap-2">
      <Textarea {...args} />
      <Button>Save</Button>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const field = within(canvasElement).getByRole('textbox');
    const button = within(canvasElement).getByRole('button', { name: 'Save' });
    await userEvent.click(field);
    await expect(field).toHaveFocus();
    await expect(field.getBoundingClientRect().right).toBeLessThanOrEqual(
      button.getBoundingClientRect().left,
    );
    const typeStep = matchMedia('(any-pointer: coarse)').matches ? '--text-lg' : '--text-md';
    await expect(getComputedStyle(field).fontSize).toBe(
      getComputedStyle(document.documentElement).getPropertyValue(typeStep).trim(),
    );
  },
};

export const WithPlaceholder: Story = {
  args: { placeholder: 'Anything worth remembering about this note' },
};

export const Disabled: Story = {
  args: { disabled: true, defaultValue: 'Quarterly plan' },
};

/** The invalid frame is driven by `aria-invalid`, here through the label and message of a Field. */
export const Invalid: Story = {
  render: (args) => (
    <Field label="Note body" error="A body is required">
      {(control) => <Textarea {...args} {...control} aria-label={undefined} />}
    </Field>
  ),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('textbox')).toBeInvalid();
  },
};

/** For a field inside an already-framed surface, where a second hairline would read as a rule. */
export const Plain: Story = {
  args: { tone: 'plain', defaultValue: 'Quarterly plan' },
};

/** Grows with its content up to the caller's cap, then scrolls. */
export const AutoGrow: Story = {
  args: {
    autoGrow: true,
    className: 'max-h-40',
    defaultValue: 'One line\nTwo lines\nThree lines\nFour lines',
  },
};
