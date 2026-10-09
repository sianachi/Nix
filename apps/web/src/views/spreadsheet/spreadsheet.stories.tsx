import { Text } from '@nix/ui';
import { useState, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';

import type { Item, PropertyDefinition, View } from '../core/container-model';
import { storyContainer, storyItem } from '../core/story-container';
import { SpreadsheetView } from './spreadsheet-view';

export default { title: 'Nix/Views/Spreadsheet', parameters: { layout: 'padded' } };

const PROPERTIES: PropertyDefinition[] = [
  { key: 'status', label: 'Status', type: 'text', options: [], required: false },
  { key: 'count', label: 'Count', type: 'number', options: [], required: false },
];
const VIEW: View = {
  id: 'spreadsheet',
  name: 'Plans',
  kind: 'sheet',
  columns: [],
  groupBy: null,
  groupOrder: [],
  rowBy: null,
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

function Example(): ReactNode {
  const [children, setChildren] = useState<readonly Item[]>([
    storyItem(
      'a',
      'A long plan title that remains readable without pushing the page outside a small phone',
      1,
      { status: 'Planning', count: 3 },
    ),
    storyItem('b', 'Write the first draft', 2, { status: 'In progress', count: 8 }),
  ]);
  const [opened, setOpened] = useState<string | null>(null);
  function apply(itemId: string, properties: Record<string, unknown>): void {
    setChildren((current) =>
      current.map((item) =>
        item.id === itemId ? { ...item, properties: { ...item.properties, ...properties } } : item,
      ),
    );
  }
  const container = storyContainer(children, PROPERTIES, {
    setProperties: (itemId, properties) => {
      apply(itemId, properties);
      return Promise.resolve(null);
    },
    setPropertiesMany: (writes) => {
      for (const write of writes) apply(write.itemId, write.properties);
      return Promise.resolve({ saved: writes.length, refused: [] });
    },
  });
  return (
    <MemoryRouter>
      <SpreadsheetView container={container} view={VIEW} onOpen={setOpened} />
      {opened === null ? null : (
        <Text as="p" variant="note" role="status">
          Opened item {opened}
        </Text>
      )}
    </MemoryRouter>
  );
}

export const Desktop = { render: (): ReactNode => <Example /> };
export const Phone = { ...Desktop, parameters: { viewport: { defaultViewport: 'mobile1' } } };
export const Tablet = { ...Desktop, parameters: { viewport: { defaultViewport: 'tablet' } } };
export const DarkDesktop = { ...Desktop, globals: { ground: 'dark' } };
export const DarkPhone = { ...Phone, globals: { ground: 'dark' } };
export const DarkTablet = { ...Tablet, globals: { ground: 'dark' } };
