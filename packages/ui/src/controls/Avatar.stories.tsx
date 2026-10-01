import { type Meta, type StoryObj } from '@storybook/react-vite';

import { Avatar } from './Avatar';

/** A person as their initials, in the same hairline square as a tag. */
const meta = {
  title: 'Controls/Avatar',
  component: Avatar,
  args: { name: 'Ada Lovelace' },
  argTypes: { size: { control: 'inline-radio', options: ['sm', 'md'] } },
} satisfies Meta<typeof Avatar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Small: Story = {};

export const Medium: Story = { args: { size: 'md' } };

/** Beside the name it decorates, which is how a card or a cell shows an assignee. */
export const WithName: Story = {
  render: () => (
    <span className="inline-flex items-center gap-2 text-sm text-foreground">
      <Avatar name="Grace Hopper" />
      Grace Hopper
    </span>
  ),
};

/** Standing alone, where it carries the name itself. */
export const Labelled: Story = { args: { labelled: true } };
