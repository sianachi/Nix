import { type Meta, type StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { Skeleton, SkeletonLines } from './Skeleton';

/**
 * Loading shapes. Decoration only: the status region beside them is what assistive technology
 * hears, so axe sees one named, busy status and no unlabelled graphics.
 */
const meta = {
  title: 'Primitives/Skeleton',
  component: SkeletonLines,
  parameters: { layout: 'padded' },
  args: { label: 'Loading the note', lines: 5, heading: true, className: 'w-96' },
} satisfies Meta<typeof SkeletonLines>;

export default meta;

type Story = StoryObj<typeof meta>;

/** A page of prose on its way: a heading, then ragged lines. */
export const Lines: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent('Loading the note');
  },
};

/** The single shapes, for callers laying out something other than prose. */
export const Shapes: Story = {
  render: () => (
    <div className="flex w-96 flex-col gap-3">
      <Skeleton shape="heading" className="w-1/2" />
      <Skeleton className="w-full" />
      <div className="h-32">
        <Skeleton shape="block" />
      </div>
    </div>
  ),
};
