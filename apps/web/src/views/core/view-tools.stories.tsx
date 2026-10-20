import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';

import type { View } from './container-model';
import { useViewState } from './view-state';
import { ViewSwitcher } from './view-switcher';
import { ViewTools } from './view-tools';

export default { title: 'Nix/Views/View tools', parameters: { layout: 'padded' } };

const VIEW: View = {
  id: 'all',
  name: 'All',
  kind: 'list',
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

function Inner(): ReactNode {
  const state = useViewState();
  return (
    <ViewTools view={VIEW} schema={[]} viewState={state} onSave={() => Promise.resolve(null)} />
  );
}

function Tools({ url = '/' }: { readonly url?: string }): ReactNode {
  return (
    <MemoryRouter initialEntries={[url]}>
      <Inner />
    </MemoryRouter>
  );
}

const PHONE = { parameters: { viewport: { defaultViewport: 'mobile1' } } };

export const Default = { render: (): ReactNode => <Tools /> };
export const Phone = { ...PHONE, render: (): ReactNode => <Tools /> };
/** Arriving with a search: the field and its Clear button are shown, never hidden. */
export const PhoneSearchOpen = {
  ...PHONE,
  render: (): ReactNode => <Tools url="/?search=Water" />,
};
export const DarkPhone = { ...Phone, globals: { ground: 'dark' } };

const VIEWS: View[] = [
  VIEW,
  { ...VIEW, id: 'board', name: 'By status', kind: 'board', groupBy: 'status' },
  { ...VIEW, id: 'cal', name: 'Schedule', kind: 'calendar' },
];

function Switcher(): ReactNode {
  return (
    <ViewSwitcher views={VIEWS} unrenderable={[]} activeViewId="all" onSelect={() => undefined} />
  );
}
export const SwitcherPhone = { ...PHONE, render: (): ReactNode => <Switcher /> };
export const SwitcherDarkPhone = { ...SwitcherPhone, globals: { ground: 'dark' } };
