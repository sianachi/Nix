import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { item, STUB_WORKSPACE, stubCoreApi } from '../api-stub';
import { renderAt, signedIn } from '../render-with-router';
import { App } from '../../app';
import { useKnownSmartListsStore } from '../../views/query/known-smart-lists';

/**
 * The rail's Queries section (plan 1.8): every smart list this browser has opened, pin and unpin,
 * and "New query" - driven through the whole application, like the rail's own tests, because what
 * a link points at is only true in a router.
 */

const WORKSPACE = STUB_WORKSPACE.id;
const ROOT = `/w/${WORKSPACE}`;

const NOTE = item({ id: '1e1e1e1e-1111-4111-8111-1e1e1e1e1e1e', title: 'Acquisition memo' });

function rail(): HTMLElement {
  return screen.getByRole('navigation', { name: /destinations/i });
}

beforeEach(() => {
  signedIn();
  useKnownSmartListsStore.setState({
    known: {
      [WORKSPACE]: [
        { id: 'list-overdue', title: 'Overdue', pinned: false },
        { id: 'list-shop', title: 'Shopping', pinned: true },
      ],
    },
  });
});

describe('the rail Queries section', () => {
  it('shows a pinned smart list as a rail destination right after Queries', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);
    await screen.findByRole('button', { name: 'Acquisition memo' });

    const labels = within(rail())
      .getAllByRole('listitem')
      .map((entry) => entry.textContent);
    expect(labels.slice(labels.indexOf('Queries'), labels.indexOf('Queries') + 2)).toEqual([
      'Queries',
      'Shopping',
    ]);
    expect(within(rail()).getByRole('link', { name: 'Shopping' })).toHaveAttribute(
      'href',
      `${ROOT}?item=list-shop`,
    );
  });

  it('lists every known smart list, pinned first, with New query', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);
    await screen.findByRole('button', { name: 'Acquisition memo' });

    await user.click(within(rail()).getByRole('button', { name: 'Queries' }));
    const menu = await screen.findByRole('menu', { name: 'Queries' });

    expect(within(menu).getByRole('menuitem', { name: 'Overdue' })).toHaveAttribute(
      'href',
      `${ROOT}?item=list-overdue`,
    );
    expect(within(menu).getByRole('menuitem', { name: 'Unpin Shopping' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'New query' })).toHaveAttribute(
      'href',
      `${ROOT}/new/query`,
    );
  });

  it('pins a smart list into the rail from the menu', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);
    await screen.findByRole('button', { name: 'Acquisition memo' });

    await user.click(within(rail()).getByRole('button', { name: 'Queries' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Pin Overdue' }));

    expect(await within(rail()).findByRole('link', { name: 'Overdue' })).toHaveAttribute(
      'href',
      `${ROOT}?item=list-overdue`,
    );
  });

  it('says when this browser has not opened any smart list yet', async () => {
    const user = userEvent.setup();
    useKnownSmartListsStore.setState({ known: {} });
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);
    await screen.findByRole('button', { name: 'Acquisition memo' });

    await user.click(within(rail()).getByRole('button', { name: 'Queries' }));

    expect(
      await screen.findByRole('menuitem', { name: 'No smart lists opened in this browser yet' }),
    ).toBeDisabled();
  });
});
