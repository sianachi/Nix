import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';

import type { PropertyDefinition, View } from '../core/container-model';
import { storyContainer, storyItem } from '../core/story-container';
import { ListView } from './list-view';

export default { title: 'Nix/Views/Grouped list', parameters: { layout: 'padded' } };

const STATUS: PropertyDefinition = {
  key: 'status',
  label: 'Status',
  type: 'select',
  options: ['To do', 'Doing', 'Done'],
  required: false,
};
const OWNER: PropertyDefinition = {
  key: 'owner',
  label: 'Owner',
  type: 'text',
  options: [],
  required: false,
};

const CHILDREN = [
  storyItem('a', 'Draft the brief', 1, { status: 'Doing', owner: 'Ada' }),
  storyItem('b', 'Book the venue', 2, { status: 'To do', owner: 'Grace' }),
  storyItem('c', 'Send invitations', 3, { status: 'To do' }),
  storyItem('d', 'Order supplies', 4, { status: 'Done', owner: 'Ada' }),
  storyItem('e', 'Loose idea', 5, {}, 'canvas'),
];

function view(overrides: Partial<View>): View {
  return {
    id: 'list',
    name: 'Tasks',
    kind: 'list',
    columns: ['owner'],
    groupBy: 'status',
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
    ...overrides,
  };
}

function Example({ overrides = {} }: { readonly overrides?: Partial<View> }): ReactNode {
  return (
    <MemoryRouter>
      <ListView
        container={storyContainer(CHILDREN, [STATUS, OWNER])}
        view={view(overrides)}
        onOpen={() => undefined}
      />
    </MemoryRouter>
  );
}

export const BySelect = { render: (): ReactNode => <Example /> };
export const ByKind = { render: (): ReactNode => <Example overrides={{ groupBy: '$type' }} /> };
export const SectionFolded = {
  render: (): ReactNode => <Example overrides={{ collapsedGroups: ['Done'] }} />,
};
export const GroupingGone = {
  render: (): ReactNode => <Example overrides={{ groupBy: 'priority' }} />,
};
export const DarkBySelect = { ...BySelect, globals: { ground: 'dark' } };
export const DarkSectionFolded = { ...SectionFolded, globals: { ground: 'dark' } };
export const Phone = { ...BySelect, parameters: { viewport: { defaultViewport: 'mobile1' } } };
export const DarkPhone = { ...Phone, globals: { ground: 'dark' } };
