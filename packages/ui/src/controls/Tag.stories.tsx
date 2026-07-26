import { type Meta, type StoryObj } from '@storybook/react-vite';

import { Tag } from './Tag';

/**
 * The three tones, which name what a tag is for rather than what colour it is.
 */
const meta = {
  title: 'Controls/Tag',
  component: Tag,
  args: { children: 'Draft' },
  argTypes: {
    tone: { control: 'inline-radio', options: ['neutral', 'accent', 'muted'] },
  },
} satisfies Meta<typeof Tag>;

export default meta;

type Story = StoryObj<typeof meta>;

/** A category, a type, a name. */
export const Neutral: Story = {};

/** Selected, current, or otherwise the one being pointed at. */
export const Accent: Story = {
  args: { tone: 'accent', children: 'Current' },
};

/** Present, but deliberately not the point. */
export const Muted: Story = {
  args: { tone: 'muted', children: 'Archived' },
};

export const InARow: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <Tag tone="accent">Note</Tag>
      <Tag>Engineering</Tag>
      <Tag>Q3</Tag>
      <Tag tone="muted">Archived</Tag>
    </div>
  ),
};
