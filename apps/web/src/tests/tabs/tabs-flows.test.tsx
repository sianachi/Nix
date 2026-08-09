import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '../../app';
import { item, stubCoreApi } from '../api-stub';
import { renderAt, signedIn } from '../render-with-router';
import { useTabOrientationStore } from '../../tabs/tab-orientation-store';
import { useTabStore } from '../../tabs/tab-store';

/**
 * Documents opened as tabs within a pane - previewed, pinned, closed, and kept straight across
 * more than one pane. `document-tab-strip.tsx` explains what this is not: not the top-level tab
 * strip `app-shell.tsx` and `view-switcher.tsx` describe rejecting. These tests hold the behaviour
 * that distinction was drawn to protect.
 */

const ALPHA = item({ id: '0a0a0a0a-0000-4000-8000-00000000000a', title: 'Alpha' });
const BRAVO = item({ id: '0b0b0b0b-0000-4000-8000-00000000000b', title: 'Bravo' });
const CHARLIE = item({ id: '0c0c0c0c-0000-4000-8000-00000000000c', title: 'Charlie' });

beforeEach(() => {
  signedIn();
  useTabStore.setState({ byPane: {} });
  useTabOrientationStore.setState({ orientation: 'horizontal' });
});

describe('previewing a document', () => {
  it('a single click opens a preview tab that the next single click replaces', async () => {
    stubCoreApi({ items: [ALPHA, BRAVO, CHARLIE] });
    const user = userEvent.setup();
    renderAt(<App />, `/?item=${ALPHA.id}`);

    await user.click(await screen.findByRole('button', { name: 'Bravo' }));
    expect(await screen.findByRole('tab', { name: 'Bravo' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await user.click(screen.getByRole('button', { name: 'Charlie' }));
    expect(await screen.findByRole('tab', { name: 'Charlie' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.queryByRole('tab', { name: 'Bravo' })).not.toBeInTheDocument();
  });
});

describe('pinning a document', () => {
  it('double-clicking a sidebar row pins it as a tab that survives the next preview', async () => {
    stubCoreApi({ items: [ALPHA, BRAVO, CHARLIE] });
    const user = userEvent.setup();
    renderAt(<App />, `/?item=${ALPHA.id}`);

    await user.dblClick(await screen.findByRole('button', { name: 'Bravo' }));
    expect(await screen.findByRole('tab', { name: 'Bravo' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await user.click(screen.getByRole('button', { name: 'Charlie' }));
    expect(await screen.findByRole('tab', { name: 'Charlie' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // Bravo was pinned by the double-click, so it survives being replaced as the preview.
    expect(screen.getByRole('tab', { name: 'Bravo' })).toBeInTheDocument();
  });

  it('editing the title pins the active tab', async () => {
    stubCoreApi({ items: [ALPHA, BRAVO] });
    const user = userEvent.setup();
    renderAt(<App />, `/?item=${ALPHA.id}`);

    await user.click(await screen.findByRole('button', { name: 'Bravo' }));
    await screen.findByRole('tab', { name: 'Bravo' });

    await user.type(screen.getByRole('textbox', { name: /note title/i }), '!');

    await user.click(screen.getByRole('button', { name: 'Alpha' }));
    await screen.findByRole('tab', { name: 'Alpha' });

    // Bravo was pinned by the edit, so it survives being replaced as the preview.
    expect(screen.getByRole('tab', { name: /^Bravo/ })).toBeInTheDocument();
  });

  it('opening an item beside pins it immediately', async () => {
    stubCoreApi({ items: [ALPHA, BRAVO] });
    const user = userEvent.setup();
    renderAt(<App />, `/?item=${ALPHA.id}`);

    await user.click(await screen.findByRole('button', { name: 'Open Bravo beside' }));

    expect(await screen.findByRole('tab', { name: 'Bravo' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(useTabStore.getState().byPane[1]).toEqual([{ itemId: BRAVO.id, pinned: true }]);
  });
});

describe('closing tabs and panes', () => {
  it('closing the last tab in a pane closes the pane', async () => {
    stubCoreApi({ items: [ALPHA, BRAVO] });
    const user = userEvent.setup();
    renderAt(<App />, `/?item=${ALPHA.id}`);

    await user.click(await screen.findByRole('button', { name: 'Open Bravo beside' }));
    await screen.findByRole('tab', { name: 'Bravo' });
    expect(screen.getAllByRole('article')).toHaveLength(2);

    // The close affordance is deliberately not an interactive role of its own (a focusable
    // control inside a role=tab is the nested-interactive axe violation); the pointer path is
    // the titled span, the keyboard path is Delete on the tab itself.
    await user.click(screen.getByTitle('Close Bravo (Delete)'));

    await waitFor(() => {
      expect(screen.getAllByRole('article')).toHaveLength(1);
    });
  });

  it('closing the middle pane of three renumbers the remaining panes’ tabs', async () => {
    stubCoreApi({ items: [ALPHA, BRAVO, CHARLIE] });
    useTabStore.setState({
      byPane: {
        0: [{ itemId: ALPHA.id, pinned: true }],
        1: [{ itemId: BRAVO.id, pinned: true }],
        2: [{ itemId: CHARLIE.id, pinned: true }],
      },
    });
    const user = userEvent.setup();
    renderAt(<App />, `/?item=${ALPHA.id}&item2=${BRAVO.id}&item3=${CHARLIE.id}`);

    await screen.findAllByRole('tab');
    const middlePane = screen.getByRole('article', { name: /Pane 2 of 3/ });

    await user.click(within(middlePane).getByRole('button', { name: 'Close pane' }));

    await waitFor(() => {
      expect(screen.getAllByRole('article')).toHaveLength(2);
    });

    expect(useTabStore.getState().byPane[0]).toEqual([{ itemId: ALPHA.id, pinned: true }]);
    expect(useTabStore.getState().byPane[1]).toEqual([{ itemId: CHARLIE.id, pinned: true }]);
    expect(useTabStore.getState().byPane[2]).toBeUndefined();
  });
});

describe('a document already open elsewhere', () => {
  it('is focused in its own pane rather than duplicated, even when only backgrounded there', async () => {
    stubCoreApi({ items: [ALPHA, BRAVO, CHARLIE] });
    useTabStore.setState({
      byPane: {
        1: [
          { itemId: BRAVO.id, pinned: true },
          { itemId: CHARLIE.id, pinned: false },
        ],
      },
    });
    const user = userEvent.setup();
    renderAt(<App />, `/?item=${ALPHA.id}&item2=${BRAVO.id}`);

    await screen.findByRole('article', { name: /Pane 1 of 2/ });

    await user.click(screen.getByRole('button', { name: 'Charlie' }));

    // Still exactly two panes - a click on an already-open, backgrounded document must not open
    // a third copy of it.
    await waitFor(() => {
      expect(screen.getAllByRole('article')).toHaveLength(2);
    });

    const firstPane = screen.getByRole('article', { name: /Pane 1 of 2/ });
    const secondPane = await screen.findByRole('article', { name: /Pane 2 of 2: Charlie/ });

    // The first pane is untouched.
    expect(within(firstPane).getByRole('tab', { name: 'Alpha' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // The second pane switched from Bravo to the backgrounded Charlie tab that was already there.
    expect(within(secondPane).getByRole('tab', { name: 'Charlie' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(secondPane).getByRole('tab', { name: 'Bravo' })).toBeInTheDocument();
  });
});

describe('refreshing', () => {
  it('collapses a pane back to the URL’s single item', async () => {
    stubCoreApi({ items: [ALPHA, BRAVO] });
    const user = userEvent.setup();
    const { unmount } = renderAt(<App />, `/?item=${ALPHA.id}`);

    await user.dblClick(await screen.findByRole('button', { name: 'Bravo' }));
    await screen.findByRole('tab', { name: 'Bravo' });
    expect(useTabStore.getState().byPane[0]).toEqual([{ itemId: BRAVO.id, pinned: true }]);

    // A refresh discards every in-memory store along with the rest of the page, including this
    // one - the tab list is session-local rather than URL-encoded, by design (`tab-store.ts`).
    unmount();
    useTabStore.setState({ byPane: {} });
    renderAt(<App />, `/?item=${BRAVO.id}`);

    expect(await screen.findByRole('tab', { name: 'Bravo' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.queryAllByRole('tab')).toHaveLength(1);
  });
});

describe('choosing horizontal or vertical tabs', () => {
  it('toggling in one pane switches every open pane, not just the one clicked', async () => {
    stubCoreApi({ items: [ALPHA, BRAVO] });
    const user = userEvent.setup();
    renderAt(<App />, `/?item=${ALPHA.id}&item2=${BRAVO.id}`);

    await screen.findByRole('tab', { name: 'Alpha' });
    for (const tablist of screen.getAllByRole('tablist')) {
      expect(tablist).not.toHaveAttribute('aria-orientation');
    }

    const firstPane = screen.getByRole('article', { name: /Pane 1 of 2/ });
    await user.click(within(firstPane).getByRole('button', { name: 'Show tabs on the side' }));

    await waitFor(() => {
      for (const tablist of screen.getAllByRole('tablist')) {
        expect(tablist).toHaveAttribute('aria-orientation', 'vertical');
      }
    });
  });

  it('switches back to horizontal on a second click', async () => {
    stubCoreApi({ items: [ALPHA] });
    const user = userEvent.setup();
    renderAt(<App />, `/?item=${ALPHA.id}`);

    await user.click(await screen.findByRole('button', { name: 'Show tabs on the side' }));
    await screen.findByRole('button', { name: 'Show tabs across the top' });

    await user.click(screen.getByRole('button', { name: 'Show tabs across the top' }));

    await waitFor(() => {
      expect(screen.getByRole('tablist')).not.toHaveAttribute('aria-orientation');
    });
  });
});
