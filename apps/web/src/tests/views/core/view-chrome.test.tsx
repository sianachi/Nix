import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderAt } from '../../render-with-router';
import { aContainer } from '../../../views/core/container-fixture';
import type { Item } from '../../../views/core/container-model';
import type { ContainerData } from '../../../views/core/use-container';
import {
  drawable,
  resolveViewChrome,
  undrawable,
  type Drawable,
} from '../../../views/core/view-chrome';
import { useViewState } from '../../../views/core/view-state';

/**
 * The five states every view shares, exercised through a view that does nothing else.
 *
 * Driven at a URL rather than by handing filters in, because the filters live in the address and a
 * test that reached past it would be testing a function this application does not call.
 */

function item(id: string, title: string, seq: number, properties: Record<string, unknown>): Item {
  return {
    id,
    workspaceId: 'workspace-1',
    parentId: 'folder-1',
    type: 'note',
    title,
    hasChildren: false,
    seq,
    lifecycleState: 'active',
    properties,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

const OPEN = item('item-o', 'Open one', 1, { status: 'open' });
const DONE = item('item-d', 'Done one', 2, { status: 'done' });

/**
 * A view with no opinions: it renders the chrome it is given, or the titles it is given.
 *
 * Deliberately anonymous - no landmark, no heading - so what the tests below see is exactly what
 * the shared chrome contributes and nothing the harness added.
 */
function Subject(props: {
  readonly container: ContainerData;
  readonly drawable?: Drawable<string>;
}): ReactNode {
  const viewState = useViewState();

  const chrome = resolveViewChrome({
    container: props.container,
    viewState,
    subject: 'this list',
    drawable: props.drawable ?? drawable('ready'),
    emptyTitle: 'Nothing in here yet',
    emptyDetail: 'Items added to this one appear here.',
    filtered: (total) => ({
      title: 'No items match the filters',
      detail: `This holds ${String(total)} items and the filters are hiding all of them.`,
    }),
    sortBy: null,
    descending: false,
  });

  if (chrome.kind === 'chrome') {
    return chrome.node;
  }

  return (
    <>
      {chrome.notice}
      <ul>
        {chrome.items.map((entry) => (
          <li key={entry.id}>{entry.title}</li>
        ))}
      </ul>
    </>
  );
}

describe('the shared view chrome', () => {
  it('tells loading apart from empty apart from filtered-to-nothing', () => {
    const { unmount } = renderAt(<Subject container={aContainer({ status: 'loading' })} />);

    expect(screen.getByText('Loading this list')).toBeVisible();
    expect(screen.queryByText('Nothing in here yet')).not.toBeInTheDocument();
    unmount();

    const empty = renderAt(<Subject container={aContainer({ children: [] })} />);

    expect(screen.getByRole('status')).toHaveTextContent('Nothing in here yet');
    expect(screen.queryByText('No items match the filters')).not.toBeInTheDocument();
    empty.unmount();

    renderAt(<Subject container={aContainer({ children: [OPEN, DONE] })} />, '/?f.status=archived');

    const filtered = screen.getByRole('status');
    expect(filtered).toHaveTextContent('No items match the filters');
    expect(filtered).toHaveTextContent('This holds 2 items');
    expect(filtered).not.toHaveTextContent('Nothing in here yet');
  });

  it('reports a container that could not be read instead of drawing an empty one', async () => {
    const user = userEvent.setup();
    const reload = vi.fn(() => Promise.resolve());

    renderAt(
      <Subject
        container={aContainer({ status: 'error', error: 'Core could not be reached.', reload })}
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('This list could not be loaded');
    expect(alert).toHaveTextContent('Core could not be reached.');
    // The one thing a failure must never be mistaken for.
    expect(screen.queryByText('Nothing in here yet')).not.toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('says a view cannot be drawn in its own words, and does not call it empty', () => {
    renderAt(
      <Subject
        container={aContainer({ children: [OPEN] })}
        drawable={undrawable({
          title: 'This board groups by a property that no longer exists',
          detail: 'The items are all still here.',
        })}
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('This board groups by a property that no longer exists');
    expect(alert).toHaveTextContent('The items are all still here.');
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('leaves the way out of a filter that hides everything on screen', async () => {
    const user = userEvent.setup();

    renderAt(<Subject container={aContainer({ children: [OPEN, DONE] })} />, '/?f.status=archived');

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));

    expect(screen.getByText('Open one')).toBeVisible();
    expect(screen.getByText('Done one')).toBeVisible();
  });

  it('says how many items the filters are holding back rather than showing part of a list silently', () => {
    renderAt(<Subject container={aContainer({ children: [OPEN, DONE] })} />, '/?f.status=open');

    expect(screen.getByText('Open one')).toBeVisible();
    expect(screen.queryByText('Done one')).not.toBeInTheDocument();
    // Filters live only in the address, so nothing else on screen would say the other one is here.
    expect(screen.getByRole('status')).toHaveTextContent(
      'One more item is here and hidden by the current filters.',
    );
  });

  it('says nothing about hidden items when the filters are hiding none', () => {
    renderAt(<Subject container={aContainer({ children: [OPEN, DONE] })} />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
