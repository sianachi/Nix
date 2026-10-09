import { useRef, useState, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';

import type { Item, View } from '../core/container-model';
import { storyContainer, storyItem } from '../core/story-container';
import type { OutlineSource } from './outline-source';
import { OutlineTree } from './outline-view';

export default { title: 'Nix/Views/Outline', parameters: { layout: 'padded' } };

const ROOT = 'story-container';

const START: readonly Item[] = [
  { ...storyItem('a', 'Trip to Lisbon', 1), hasChildren: true },
  { ...storyItem('a1', 'Book flights', 1), parentId: 'a' },
  { ...storyItem('a2', 'Find somewhere to stay', 2), parentId: 'a' },
  storyItem('b', 'Renew passport', 2),
  { ...storyItem('c', 'Archive', 3), noChildren: true },
];

const VIEW: View = {
  id: 'outline',
  name: 'Plans',
  kind: 'outline',
  columns: [],
  groupBy: null,
  groupOrder: [],
  dateProperty: null,
  sortBy: null,
  sortDescending: false,
  mode: null,
  coverProperty: null,
  endDateProperty: null,
  cardSize: null,
  layout: null,
  filters: [],
};

/** One parent's children in sibling order, each saying whether it holds anything itself. */
function childrenIn(items: readonly Item[], parentId: string | null): Item[] {
  return items
    .filter((item) => item.parentId === parentId)
    .sort((left, right) => Number(left.seq) - Number(right.seq))
    .map((item) => ({
      ...item,
      hasChildren: items.some((candidate) => candidate.parentId === item.id),
    }));
}

/** An outline over an in-memory tree: moves and adds land in place, as Core would order them. */
function Example({ empty = false }: { readonly empty?: boolean }): ReactNode {
  const [items, setItems] = useState<readonly Item[]>(empty ? [] : START);
  const latest = useRef(items);
  const commit = (next: readonly Item[]): void => {
    latest.current = next;
    setItems(next);
  };
  const childrenOf = (parentId: string | null): Item[] => childrenIn(latest.current, parentId);

  const source: OutlineSource = {
    list: (parentId) => Promise.resolve(childrenOf(parentId)),
    create: (parentId, title) => {
      const item = {
        ...storyItem(`n-${String(latest.current.length)}`, title, latest.current.length + 1),
        parentId,
      };
      commit([...latest.current, item]);
      return Promise.resolve(item);
    },
    move: (itemId, _from, parentId, afterId) => {
      const siblings = childrenOf(parentId).filter((item) => item.id !== itemId);
      const at = afterId === null ? 0 : siblings.findIndex((item) => item.id === afterId) + 1;
      const order = [...siblings.slice(0, at), { id: itemId }, ...siblings.slice(at)].map(
        (item) => item.id,
      );
      commit(
        latest.current.map((item) =>
          order.includes(item.id) ? { ...item, parentId, seq: order.indexOf(item.id) + 1 } : item,
        ),
      );
      return Promise.resolve();
    },
  };

  return (
    <MemoryRouter>
      <div className="max-w-xl">
        <OutlineTree
          container={storyContainer(childrenIn(items, ROOT), [])}
          view={VIEW}
          onOpen={() => undefined}
          source={source}
        />
      </div>
    </MemoryRouter>
  );
}

export const Plans = { render: (): ReactNode => <Example /> };
export const Empty = { render: (): ReactNode => <Example empty /> };
export const DarkPlans = { ...Plans, globals: { ground: 'dark' } };
export const DarkEmpty = { ...Empty, globals: { ground: 'dark' } };
