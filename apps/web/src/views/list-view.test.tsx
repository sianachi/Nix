import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { renderAt } from '../test/render-with-router';
import type { EffectiveSchema, Item, PropertyDefinition, View } from './container-model';
import { ListView } from './list-view';
import { aContainer } from './container-fixture';
import type { ContainerData } from './use-container';

/**
 * The list view, driven the way a person drives it: through the address bar and the pointer.
 *
 * Every test renders at a URL rather than setting up state, because the URL *is* the state - a
 * test that reached past it would be testing a component this application does not have.
 */

function item(
  id: string,
  title: string,
  seq: number,
  properties: Record<string, unknown> = {},
): Item {
  return {
    id,
    workspaceId: 'workspace-1',
    parentId: 'folder-1',
    type: 'note',
    title,
    seq,
    lifecycleState: 'active',
    properties,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function property(key: string, label: string, type: string): PropertyDefinition {
  return { key, label, type, options: [], required: false };
}

function schemaOf(...properties: PropertyDefinition[]): EffectiveSchema {
  return { properties, declared: properties, inherit: true };
}

function viewOf(overrides: Partial<View> = {}): View {
  return {
    id: 'view-1',
    name: 'Everything',
    kind: 'list',
    columns: [],
    groupBy: null,
    groupOrder: [],
    dateProperty: null,
    sortBy: null,
    sortDescending: false,
    ...overrides,
  };
}

function containerData(overrides: Partial<ContainerData> = {}): ContainerData {
  return aContainer(overrides);
}

/** Reports the address back to the test, so a URL-held sort can be asserted on as a fact. */
function CurrentSearch(): ReactNode {
  const location = useLocation();
  return <p role="status">{location.search}</p>;
}

const ZETA = item('item-z', 'Zeta', 1, { status: 'open' });
const ALPHA = item('item-a', 'Alpha', 2, { status: 'done' });

function headers(): (string | null)[] {
  return screen.getAllByRole('columnheader').map((header) => header.textContent);
}

function titles(): (string | null)[] {
  return screen.getAllByRole('rowheader').map((cell) => cell.textContent);
}

describe('ListView', () => {
  it('takes its columns from the schema, in the schema order, behind the title', () => {
    renderAt(
      <ListView
        container={containerData({
          schema: schemaOf(
            property('status', 'Status', 'select'),
            property('owner', 'Owner', 'text'),
          ),
          children: [ZETA],
        })}
        view={null}
        onOpen={vi.fn()}
      />,
    );

    expect(headers()).toEqual(['Title', 'Status', 'Owner']);
  });

  it('shows the columns the view names, in the order the view names them', () => {
    renderAt(
      <ListView
        container={containerData({
          schema: schemaOf(
            property('status', 'Status', 'select'),
            property('owner', 'Owner', 'text'),
          ),
          children: [ZETA],
        })}
        view={viewOf({ columns: ['owner', 'status'] })}
        onOpen={vi.fn()}
      />,
    );

    expect(headers()).toEqual(['Title', 'Owner', 'Status']);
  });

  it('still lists the items when the container has no schema at all', () => {
    renderAt(
      <ListView
        container={containerData({ children: [ZETA, ALPHA] })}
        view={null}
        onOpen={vi.fn()}
      />,
    );

    expect(headers()).toEqual(['Title']);
    expect(titles()).toEqual(['Zeta', 'Alpha']);
  });

  it('heads a column the schema does not describe with the key it was configured under', () => {
    renderAt(
      <ListView
        container={containerData({ schema: schemaOf(), children: [ZETA] })}
        view={viewOf({ columns: ['renamed_property'] })}
        onOpen={vi.fn()}
      />,
    );

    expect(headers()).toEqual(['Title', 'renamed_property']);
  });

  it('leaves the items in the order somebody arranged them until a column is chosen', () => {
    renderAt(
      <ListView
        container={containerData({ children: [ZETA, ALPHA] })}
        view={null}
        onOpen={vi.fn()}
      />,
    );

    expect(titles()).toEqual(['Zeta', 'Alpha']);
    expect(screen.getByRole('columnheader', { name: 'Title' })).toHaveAttribute(
      'aria-sort',
      'none',
    );
  });

  it('sorts by the column whose header is clicked', async () => {
    const user = userEvent.setup();
    renderAt(
      <ListView
        container={containerData({ children: [ZETA, ALPHA] })}
        view={null}
        onOpen={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Title' }));

    expect(titles()).toEqual(['Alpha', 'Zeta']);
    expect(screen.getByRole('columnheader', { name: 'Title' })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
  });

  it('reverses the sort when the sorted column is clicked again', async () => {
    const user = userEvent.setup();
    renderAt(
      <ListView
        container={containerData({ children: [ZETA, ALPHA] })}
        view={null}
        onOpen={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Title' }));
    await user.click(screen.getByRole('button', { name: 'Title' }));

    expect(titles()).toEqual(['Zeta', 'Alpha']);
    expect(screen.getByRole('columnheader', { name: 'Title' })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });

  it('writes the sort into the address', async () => {
    const user = userEvent.setup();
    renderAt(
      <>
        <ListView
          container={containerData({ children: [ZETA, ALPHA] })}
          view={null}
          onOpen={vi.fn()}
        />
        <CurrentSearch />
      </>,
    );

    await user.click(screen.getByRole('button', { name: 'Title' }));

    // The point of the exercise: the sort is linkable, bookmarkable and restorable because it is
    // in the URL and nowhere else.
    expect(screen.getByRole('status')).toHaveTextContent('sort=title');
    expect(screen.getByRole('status')).toHaveTextContent('dir=ascending');
  });

  it('renders the sort the address arrives with, having held none of its own', () => {
    renderAt(
      <ListView
        container={containerData({ children: [ZETA, ALPHA] })}
        view={null}
        onOpen={vi.fn()}
      />,
      '/?sort=title&dir=descending',
    );

    expect(titles()).toEqual(['Zeta', 'Alpha']);
    expect(screen.getByRole('columnheader', { name: 'Title' })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });

  it('prefers the address over the sort the view was stored with', () => {
    renderAt(
      <ListView
        container={containerData({ children: [ZETA, ALPHA] })}
        view={viewOf({ sortBy: 'title', sortDescending: true })}
        onOpen={vi.fn()}
      />,
      '/?sort=title&dir=ascending',
    );

    expect(titles()).toEqual(['Alpha', 'Zeta']);
  });

  it('applies the filters the address carries', () => {
    renderAt(
      <ListView
        container={containerData({
          schema: schemaOf(property('status', 'Status', 'select')),
          children: [ZETA, ALPHA],
        })}
        view={null}
        onOpen={vi.fn()}
      />,
      '/?f.status=open',
    );

    expect(titles()).toEqual(['Zeta']);
  });

  it('says the filters are hiding the items rather than saying there is nothing here', () => {
    renderAt(
      <ListView
        container={containerData({
          schema: schemaOf(property('status', 'Status', 'select')),
          children: [ZETA, ALPHA],
        })}
        view={null}
        onOpen={vi.fn()}
      />,
      '/?f.status=archived',
    );

    // Somebody told "this folder is empty" here goes looking for two notes they think are gone.
    expect(
      screen.getByText('All 2 items in here are hidden by the current filters.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Nothing in here yet.')).not.toBeInTheDocument();
  });

  it('offers a way out of a filter that hides everything', async () => {
    const user = userEvent.setup();
    renderAt(
      <ListView
        container={containerData({
          schema: schemaOf(property('status', 'Status', 'select')),
          children: [ZETA, ALPHA],
        })}
        view={null}
        onOpen={vi.fn()}
      />,
      '/?f.status=archived',
    );

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));

    expect(titles()).toEqual(['Zeta', 'Alpha']);
  });

  it('says there is nothing here when there is nothing here', () => {
    renderAt(<ListView container={containerData()} view={null} onOpen={vi.fn()} />);

    expect(screen.getByText('Nothing in here yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
  });

  it('does not call unanswered contents empty', () => {
    renderAt(
      <ListView container={containerData({ status: 'loading' })} view={null} onOpen={vi.fn()} />,
    );

    expect(screen.queryByText('Nothing in here yet.')).not.toBeInTheDocument();
    expect(screen.getByText('Loading the contents')).toBeInTheDocument();
    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'true');
  });

  it('reports contents that could not be read instead of drawing an empty table', () => {
    renderAt(
      <ListView
        container={containerData({ status: 'error', error: 'Core could not be reached.' })}
        view={null}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Core could not be reached.');
    // A header row over a failure reads as a folder with nothing in it, which is the one thing we
    // know it is not.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('asks the container again when the failure is retried', async () => {
    const user = userEvent.setup();
    const reload = vi.fn(() => Promise.resolve());
    renderAt(
      <ListView
        container={containerData({ status: 'error', error: 'Core could not be reached.', reload })}
        view={null}
        onOpen={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('opens the item whose title is clicked', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    renderAt(
      <ListView
        container={containerData({ children: [ZETA, ALPHA] })}
        view={null}
        onOpen={onOpen}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Alpha' }));

    expect(onOpen).toHaveBeenCalledWith('item-a');
  });

  it('renders the value of a property type this build has never heard of', () => {
    renderAt(
      <ListView
        container={containerData({
          schema: schemaOf(property('rating', 'Rating', 'constellation')),
          children: [item('item-r', 'Rated', 1, { rating: 'four of five' })],
        })}
        view={null}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByRole('cell', { name: 'four of five' })).toBeInTheDocument();
  });

  it('leaves a cell blank rather than printing a placeholder for a value the item has not got', () => {
    renderAt(
      <ListView
        container={containerData({
          schema: schemaOf(property('owner', 'Owner', 'text')),
          children: [item('item-n', 'Unassigned', 1)],
        })}
        view={null}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByRole('cell')).toHaveTextContent('');
  });
});
