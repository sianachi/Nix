import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import { type Meta, type StoryObj } from '@storybook/react-vite';

import { Select } from './Select';
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

/** Two strips exercising the primitive's generic drag callbacks; the product owns transfer state. */
function TransferExample(): ReactNode {
  const [left, setLeft] = useState<readonly TabItem[]>([
    { id: 'a', label: 'Meeting notes', pinned: true },
    { id: 'b', label: 'Roadmap', pinned: true },
  ]);
  const [right, setRight] = useState<readonly TabItem[]>([
    { id: 'c', label: 'Design review', pinned: true },
  ]);
  const dragged = useRef<string | null>(null);

  function move(id: string | null, destination: 'left' | 'right'): void {
    if (id === null) return;
    const item = [...left, ...right].find((candidate) => candidate.id === id);
    if (item === undefined) return;
    setLeft((current) =>
      destination === 'left'
        ? [...current.filter((candidate) => candidate.id !== id), item]
        : current.filter((candidate) => candidate.id !== id),
    );
    setRight((current) =>
      destination === 'right'
        ? [...current.filter((candidate) => candidate.id !== id), item]
        : current.filter((candidate) => candidate.id !== id),
    );
    dragged.current = null;
  }

  function accept(event: DragEvent<HTMLDivElement>, destination: 'left' | 'right'): void {
    event.preventDefault();
    move(dragged.current, destination);
  }

  function strip(
    items: readonly TabItem[],
    activeId: string,
    destination: 'left' | 'right',
  ): ReactNode {
    return (
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- This story-only wrapper demonstrates pointer drop plumbing; its sibling native Select supplies the keyboard path outside Tabs.
      <div
        className="min-w-0 flex-1"
        onDragOver={(event) => {
          event.preventDefault();
        }}
        onDrop={(event) => {
          accept(event, destination);
        }}
      >
        <Tabs
          label={`${destination === 'left' ? 'Left' : 'Right'} documents`}
          items={items}
          activeId={activeId}
          onActivate={() => undefined}
          drag={{
            onStart: (id) => {
              dragged.current = id;
            },
            onEnd: () => {
              dragged.current = null;
            },
          }}
        />
        <Select
          value=""
          disabled={items.length === 0}
          aria-label={`Move active tab to ${destination === 'left' ? 'right' : 'left'} documents`}
          onChange={() => {
            move(activeId, destination === 'left' ? 'right' : 'left');
          }}
          className="mt-2"
        >
          <option value="" disabled>
            Move active tab…
          </option>
          <option value="move">
            Move to {destination === 'left' ? 'right' : 'left'} documents
          </option>
        </Select>
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      {strip(left, left[0]?.id ?? '', 'left')}
      {strip(right, right[0]?.id ?? '', 'right')}
    </div>
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

/** Drag a tab from either strip to the other; app code decides what the move means. */
export const DraggableBetweenStrips: Story = {
  render: () => <TransferExample />,
};
