import { useState, type ReactNode } from 'react';
import { type Meta, type StoryObj } from '@storybook/react-vite';

import { Tabs, type TabItem, type TabsOrientation } from './Tabs';

/**
 * A strip of open documents, one of them showing.
 *
 * A real tablist, unlike `<Segmented>`: each tab is bound to distinct content that keeps running
 * while backgrounded, so it owes roving tabindex and arrow-key movement between tabs.
 */
const meta = {
  title: 'Controls/Tabs',
  component: Tabs,
  args: {
    label: 'Open documents',
    items: [
      { id: 'a', label: 'Meeting notes', pinned: true },
      { id: 'b', label: 'Roadmap', pinned: false },
    ],
    activeId: 'a',
    onActivate: () => undefined,
  },
} satisfies Meta<typeof Tabs>;

export default meta;

type Story = StoryObj<typeof meta>;

/** A caller that owns which tab is active, so the strip can be exercised for real. */
function Example({
  items,
  initial,
  closable = true,
  orientation,
}: {
  readonly items: readonly TabItem[];
  readonly initial: string;
  readonly closable?: boolean;
  readonly orientation?: TabsOrientation;
}): ReactNode {
  const [tabs, setTabs] = useState(items);
  const [activeId, setActiveId] = useState(initial);

  const onClose = (id: string): void => {
    setTabs((current) => current.filter((tab) => tab.id !== id));
  };

  return (
    <Tabs
      label="Open documents"
      items={tabs}
      activeId={activeId}
      onActivate={setActiveId}
      {...(orientation === undefined ? {} : { orientation })}
      {...(closable ? { onClose } : {})}
    />
  );
}

/** One pinned tab and one preview - the ordinary case of browsing from the tree. */
export const PinnedAndPreview: Story = {
  render: () => (
    <Example
      items={[
        { id: 'a', label: 'Meeting notes', pinned: true },
        { id: 'b', label: 'Roadmap', pinned: false },
      ]}
      initial="a"
    />
  ),
};

/** A pane with several documents pinned open at once. */
export const SeveralPinned: Story = {
  render: () => (
    <Example
      items={[
        { id: 'a', label: 'Meeting notes', pinned: true },
        { id: 'b', label: 'Roadmap', pinned: true },
        { id: 'c', label: 'Design review', pinned: true },
        { id: 'd', label: 'Sprint board', pinned: false },
      ]}
      initial="c"
    />
  ),
};

/** More tabs than the pane is wide - the strip scrolls rather than wrapping or shrinking labels. */
export const Overflow: Story = {
  render: () => (
    <div className="max-w-sm">
      <Example
        items={Array.from({ length: 10 }, (_, index) => ({
          id: `doc-${String(index)}`,
          label: `Document ${String(index + 1)}`,
          pinned: true,
        }))}
        initial="doc-0"
      />
    </div>
  ),
};

/** A tab that cannot be closed from the strip - not a case the product uses today, but the shape
 * the primitive supports. */
export const NotClosable: Story = {
  render: () => (
    <Example
      items={[
        { id: 'a', label: 'Meeting notes', pinned: true, closable: false },
        { id: 'b', label: 'Roadmap', pinned: true },
      ]}
      initial="a"
    />
  ),
};

/** Tab the strip's tabs to see focus move without activating; Enter activates the focused one. */
export const KeyboardNavigation: Story = {
  render: () => (
    <Example
      items={[
        { id: 'a', label: 'Meeting notes', pinned: true },
        { id: 'b', label: 'Roadmap', pinned: true },
        { id: 'c', label: 'Design review', pinned: false },
      ]}
      initial="a"
    />
  ),
};

/** The rail a pane draws when tabs are switched to vertical - Up and Down move focus, not Left
 * and Right, and a long title truncates rather than widening the rail. */
export const Vertical: Story = {
  render: () => (
    <Example
      orientation="vertical"
      items={[
        { id: 'a', label: 'Meeting notes', pinned: true },
        { id: 'b', label: 'A much longer document title than the rail is wide', pinned: true },
        { id: 'c', label: 'Design review', pinned: false },
      ]}
      initial="a"
    />
  ),
};
