import { useId, useState, type ReactNode } from 'react';
import { type Meta, type StoryObj } from '@storybook/react-vite';

import { Text } from '../primitives/Text';
import { Segmented } from './Segmented';

/**
 * A small set of alternatives, one of them current.
 *
 * `aria-current`, not a tablist: these are buttons that change what is beside them, and claiming to
 * be tabs would owe roving tabindex, arrow-key movement and panels wired by id.
 */
const meta = {
  title: 'Controls/Segmented',
  component: Segmented,
  // Controlled by design, so the default args stand in for a caller that owns the value. Every
  // story below renders its own state, because that is how it is actually used.
  args: {
    label: 'Calendar grain',
    options: [
      { value: 'month', label: 'Month' },
      { value: 'week', label: 'Week' },
    ],
    value: 'week',
    onChange: () => undefined,
  },
} satisfies Meta<typeof Segmented>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * A caller that owns the value.
 *
 * A real component rather than a `render` callback holding a hook: a callback is not a component,
 * so React's rules do not apply to it and the hook would be a bug that happens to work.
 */
function Example({
  label,
  options,
  initial,
}: {
  readonly label: string;
  readonly options: readonly { value: string; label: string }[];
  readonly initial: string;
}): ReactNode {
  const [value, setValue] = useState(initial);

  return <Segmented label={label} options={options} value={value} onChange={setValue} />;
}

/** The calendar's grain. Three is about the most this shape carries before it wants a select. */
export const Grain: Story = {
  render: () => (
    <Example
      label="Calendar grain"
      options={[
        { value: 'month', label: 'Month' },
        { value: 'week', label: 'Week' },
        { value: 'day', label: 'Day' },
      ]}
      initial="week"
    />
  ),
};

/** The settings panel's three panes. */
export const Panes: Story = {
  render: () => (
    <Example
      label="What to configure"
      options={[
        { value: 'details', label: 'Details' },
        { value: 'fields', label: 'Fields' },
        { value: 'views', label: 'Views' },
      ]}
      initial="details"
    />
  ),
};

/**
 * A choice whose consequence needs a sentence.
 *
 * The note beneath is wired to the group with `describedBy`, so it is part of what the control
 * announces rather than a paragraph that happens to sit nearby. Without the wiring, somebody
 * reading with a screen reader lands on the group, hears three unexplained words - "Small, Medium,
 * Large" - and moves on before the explanation is ever read.
 */
function Described(): ReactNode {
  const noteId = useId();
  const [value, setValue] = useState('medium');

  return (
    <div className="flex flex-col gap-1">
      <Segmented
        label="Card size"
        describedBy={noteId}
        options={[
          { value: 'small', label: 'Small' },
          { value: 'medium', label: 'Medium' },
          { value: 'large', label: 'Large' },
        ]}
        value={value}
        onChange={setValue}
      />
      <Text id={noteId} variant="note" tone="muted">
        Larger cards show the cover image and the first line of the body.
      </Text>
    </div>
  );
}

export const DescribedByANote: Story = {
  render: () => <Described />,
};

/** Two members, which is the smallest set worth this shape. */
export const Pair: Story = {
  render: () => (
    <Example
      label="Layout"
      options={[
        { value: 'list', label: 'List' },
        { value: 'board', label: 'Board' },
      ]}
      initial="list"
    />
  ),
};
