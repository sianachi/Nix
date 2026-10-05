import { type Meta, type StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { Text } from '../primitives/Text';
import { Button } from './Button';
import { Card } from './Card';
import { Tag } from './Tag';

/**
 * The titled blueprint figure, at each heading level and with each part present or absent.
 *
 * Cards are transparent line drawings: there is no filled story here because there is no filled
 * card, and that is a property of the component rather than a convention.
 */
const meta = {
  title: 'Controls/Card',
  component: Card,
  args: {
    title: 'Version retention',
    children: <Text variant="bodySmall">Versions are kept for thirty days, then coalesced.</Text>,
  },
  argTypes: {
    headingLevel: { control: 'inline-radio', options: [2, 3, 4] },
  },
} satisfies Meta<typeof Card>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole('heading', { level: 2, name: 'Version retention' }),
    ).toBeInTheDocument();
  },
};

export const WithKicker: Story = {
  args: { kicker: 'Workspace policy' },
};

/** A card nested inside a section that already owns an h2. */
export const NestedHeadingLevel: Story = {
  args: { headingLevel: 3, kicker: 'Workspace policy' },
};

/**
 * The card on ink: a transparent line drawing over the dark ground, which is
 * the case that proves the frame carries no fill of its own - a card with a
 * surface would show as a paper-coloured rectangle here.
 */
export const DarkGround: Story = {
  args: { kicker: 'Workspace policy' },
  globals: { ground: 'dark' },
};

export const WithActions: Story = {
  args: {
    kicker: 'Workspace policy',
    children: (
      <>
        <Text variant="bodySmall">Versions are kept for thirty days, then coalesced.</Text>
        <div className="flex items-center gap-2">
          <Tag tone="accent">Enabled</Tag>
          <Button variant="secondary" className="ml-auto">
            Change
          </Button>
        </div>
      </>
    ),
  },
};
