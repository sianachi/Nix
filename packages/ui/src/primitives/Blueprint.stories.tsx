import { type Meta, type StoryObj } from '@storybook/react-vite';
import { Clock, FileText } from 'lucide-react';

import { Button } from '../controls/Button';
import { Blueprint } from './Blueprint';
import { Icon } from './Icon';
import { Text } from './Text';

/**
 * The frame is a line drawing: a hairline border, four corner registration
 * marks, square corners, and no fill. Cards and figures are built out of it;
 * nothing framed ever drops the marks.
 */
const meta = {
  title: 'Primitives/Blueprint',
  component: Blueprint,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Blueprint>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The frame on its own, so the marks and the hairline are visible. */
export const Empty: Story = {
  args: {
    className: 'h-24 w-64',
  },
};

/** A card: kicker, title, body and a meta row, all inside the frame. */
export const Card: Story = {
  args: {
    className: 'w-80 p-3',
    children: (
      <div className="flex flex-col gap-2">
        <Text variant="kicker" tone="accent">
          Contract
        </Text>
        <Text variant="h4" as="h3">
          Master services agreement
        </Text>
        <Text variant="bodySmall" tone="muted">
          Searchable once indexing finishes. Downloadable now.
        </Text>
        <div className="flex items-center gap-2">
          <Icon icon={Clock} size="sm" />
          <Text variant="caption" tone="muted" as="span">
            Updated 4 minutes ago
          </Text>
        </div>
      </div>
    ),
  },
};

/** A figure: the same frame around content, never rounded and never clipped. */
export const Figure: Story = {
  args: {
    className: 'w-80 p-6',
    children: (
      <div className="flex flex-col items-center gap-3">
        <Icon icon={FileText} size="lg" />
        <Text variant="caption" tone="muted" as="span">
          Figure 1 - envelope structure
        </Text>
      </div>
    ),
  },
};

/** Cards keep their grammar in a grid: equal cells, visible rhythm. */
export const Grid: Story = {
  render: () => (
    <div className="grid grid-cols-2 gap-8">
      {['Envelope', 'Closure', 'Permissions', 'Search'].map((title) => (
        <Blueprint key={title} className="p-3">
          <div className="flex flex-col gap-2">
            <Text variant="h5" as="h3">
              {title}
            </Text>
            <Text variant="bodySmall" tone="muted">
              A transparent line drawing. No surface fill exists to ask for.
            </Text>
          </div>
        </Blueprint>
      ))}
    </div>
  ),
};

/**
 * The frame next to the primary button: the same marks, drawn once and shared,
 * on the one object that is allowed to be solid.
 */
export const WithPrimaryButton: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-8">
      <Blueprint className="w-80 p-3">
        <Text variant="bodySmall">
          A card is transparent. The button below is the only filled object.
        </Text>
      </Blueprint>
      <Button variant="primary">Publish document</Button>
    </div>
  ),
};
