import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as importRun from '../../import/import-run';
import { item, stubCoreApi } from '../api-stub';
import { renderAt, signedIn } from '../render-with-router';
import { stubViewport } from '../stub-viewport';
import { App } from '../../app';

/**
 * The navigation rail: the workspace-level destinations, Notes among them.
 *
 * Driven through the whole application rather than the component in isolation, because half of
 * what the rail promises is only true in a router - which link the URL makes current, and what
 * following one does to the address. The rail's own keyboard contract is asserted here too, on
 * the real controls, since a roving tabindex is a claim about the document's tab order and
 * nothing short of tabbing through it checks that.
 */
beforeEach(() => {
  signedIn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const NOTE = item({
  id: '1e1e1e1e-1111-4111-8111-1e1e1e1e1e1e',
  title: 'Acquisition memo',
});

function rail(): HTMLElement {
  return screen.getByRole('navigation', { name: /destinations/i });
}

describe('the navigation rail', () => {
  it('names every control, so an icon is never the only thing it says', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Acquisition memo' });

    const items = within(rail()).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Notes',
      'Daily note',
      'Calendar',
      'Graph',
      'Bookmarks',
      'Templates',
      'Import',
      'Settings',
    ]);
    expect(within(rail()).getByRole('link', { name: 'Notes' })).toHaveAttribute('href', '/');
    expect(within(rail()).getByRole('link', { name: 'Daily note' })).toHaveAttribute(
      'href',
      '/daily',
    );
    expect(within(rail()).getByRole('link', { name: 'Calendar' })).toHaveAttribute(
      'href',
      '/calendar',
    );
    expect(within(rail()).getByRole('button', { name: 'Import' })).toBeInTheDocument();
    expect(within(rail()).getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/settings',
    );
  });

  it('costs one Tab press to enter and one to leave, however many destinations it holds', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, '/calendar');

    await screen.findByRole('heading', { name: 'Calendar' });

    const notes = within(rail()).getByRole('link', { name: 'Notes' });
    const calendar = within(rail()).getByRole('link', { name: 'Calendar' });
    const graph = within(rail()).getByRole('link', { name: 'Graph' });
    const bookmarks = within(rail()).getByRole('link', { name: 'Bookmarks' });
    const templates = within(rail()).getByRole('link', { name: 'Templates' });
    const importControl = within(rail()).getByRole('button', { name: 'Import' });
    const settings = within(rail()).getByRole('link', { name: 'Settings' });

    // Only the entry point is in the tab order; the others are reachable by arrow key alone.
    expect(notes).toHaveAttribute('tabindex', '-1');
    expect(calendar).toHaveAttribute('tabindex', '0');
    expect(graph).toHaveAttribute('tabindex', '-1');
    expect(bookmarks).toHaveAttribute('tabindex', '-1');
    expect(templates).toHaveAttribute('tabindex', '-1');
    expect(importControl).toHaveAttribute('tabindex', '-1');
    expect(settings).toHaveAttribute('tabindex', '-1');

    // Tab reaches the skip link, then the rail, then leaves it - every destination, one stop.
    await user.tab();
    await user.tab();
    expect(calendar).toHaveFocus();

    await user.tab();
    expect(rail()).not.toContainElement(document.activeElement as HTMLElement | null);
  });

  it('moves between destinations with the arrow keys, and stops at the ends', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, '/calendar');

    await screen.findByRole('heading', { name: 'Calendar' });

    const notes = within(rail()).getByRole('link', { name: 'Notes' });
    const daily = within(rail()).getByRole('link', { name: 'Daily note' });
    const calendar = within(rail()).getByRole('link', { name: 'Calendar' });
    const graph = within(rail()).getByRole('link', { name: 'Graph' });
    const templates = within(rail()).getByRole('link', { name: 'Templates' });
    const importControl = within(rail()).getByRole('button', { name: 'Import' });
    const settings = within(rail()).getByRole('link', { name: 'Settings' });

    calendar.focus();

    await user.keyboard('{ArrowUp}');
    expect(daily).toHaveFocus();

    await user.keyboard('{ArrowUp}');
    expect(notes).toHaveFocus();

    // Nothing wraps: the ends of the rail are meant to be findable by feel.
    await user.keyboard('{ArrowUp}');
    expect(notes).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(daily).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(calendar).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(graph).toHaveFocus();

    templates.focus();
    await user.keyboard('{ArrowDown}');
    expect(importControl).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(settings).toHaveFocus();

    await user.keyboard('{End}');
    expect(settings).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(settings).toHaveFocus();

    await user.keyboard('{Home}');
    expect(notes).toHaveFocus();
  });

  it('leaves the tab stop where focus last was, so tabbing out and back returns there', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, '/calendar');

    await screen.findByRole('heading', { name: 'Calendar' });

    const graph = within(rail()).getByRole('link', { name: 'Graph' });
    within(rail()).getByRole('link', { name: 'Calendar' }).focus();
    await user.keyboard('{ArrowDown}');

    expect(graph).toHaveAttribute('tabindex', '0');
    expect(within(rail()).getByRole('link', { name: 'Calendar' })).toHaveAttribute(
      'tabindex',
      '-1',
    );
  });

  it('marks where you are with aria-current rather than with colour alone', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, '/graph');

    await screen.findByRole('heading', { name: 'Graph' });

    expect(within(rail()).getByRole('link', { name: 'Graph' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(rail()).getByRole('link', { name: 'Calendar' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('uses Templates as the current roving entry throughout its nested routes', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, '/templates/import');

    await screen.findByRole('heading', { name: 'Import template' });

    const notes = within(rail()).getByRole('link', { name: 'Notes' });
    const templates = within(rail()).getByRole('link', { name: 'Templates' });
    expect(templates).toHaveAttribute('aria-current', 'page');
    expect(templates).toHaveAttribute('tabindex', '0');
    expect(notes).toHaveAttribute('tabindex', '-1');
  });

  it('marks Notes as current while a document is open, because that is what it now is', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Acquisition memo' });

    expect(within(rail()).getByRole('link', { name: 'Notes' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    for (const label of ['Calendar', 'Graph', 'Bookmarks', 'Templates', 'Settings']) {
      expect(within(rail()).getByRole('link', { name: label })).not.toHaveAttribute('aria-current');
    }
    expect(within(rail()).getByRole('button', { name: 'Import' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('opens a workspace-level import without requiring a note to be open', async () => {
    const user = userEvent.setup();
    const run = vi.spyOn(importRun, 'runImportPlan').mockResolvedValue({
      rootItemId: null,
      created: [],
      failed: [],
      notAttempted: [],
      stoppedEarly: false,
      couldNotStart: 'Stopped after the request was captured.',
    });
    stubCoreApi();
    renderAt(<App />);

    await user.click(within(rail()).getByRole('button', { name: 'Import' }));
    const dialog = screen.getByRole('dialog', { name: 'Import' });
    expect(within(dialog).getByText(/Obsidian vault/i)).toBeVisible();

    await user.upload(
      within(dialog).getByLabelText('Markdown files to import'),
      new File(['Body.'], 'note.md', { type: 'text/markdown' }),
    );
    await user.click(await within(dialog).findByRole('button', { name: 'Import 2 items' }));

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ parentId: null }));
  });

  it('changes the address when a destination is followed', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Acquisition memo' });
    await user.click(within(rail()).getByRole('link', { name: 'Bookmarks' }));

    expect(await screen.findByRole('heading', { name: 'Bookmarks' })).toBeInTheDocument();
    expect(within(rail()).getByRole('link', { name: 'Bookmarks' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  /*
   * The deliberate-stub test that lived here is gone, and its absence is the point: every
   * destination the rail offers is now built, so there is no placeholder left to assert on. The
   * rule it guarded - a destination the product cannot yet fill says so rather than drawing an
   * empty one that looks finished - still stands, and `status-panels.tsx`'s `EmptyPanel` is still
   * how it would be honoured. Reinstate a test here the next time a route lands ahead of its view.
   */
});

/**
 * jsdom lays nothing out, so what a narrow viewport means here is the code path
 * `viewport.ts`'s `useNarrowViewport` takes when its window query does not match - the same technique, and
 * the same helper, `sidebar.test.tsx` uses for the drawer.
 */
describe('the navigation rail on a narrow screen', () => {
  it('stays at the left edge, because nothing else in the shell reaches these destinations', async () => {
    stubViewport(false);
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await screen.findByRole('button', { name: /show the workspace tree/i });
    expect(within(rail()).getAllByRole('link')).toHaveLength(7);
    expect(within(rail()).getByRole('button', { name: 'Import' })).toBeVisible();
  });

  it('dismisses the tree drawer on the way to a destination, rather than leaving it over the top', async () => {
    const user = userEvent.setup();
    stubViewport(false);
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /show the workspace tree/i }));
    expect(await screen.findByRole('complementary', { name: /workspace/i })).toBeVisible();

    await user.click(within(rail()).getByRole('link', { name: 'Graph' }));

    expect(await screen.findByRole('heading', { name: 'Graph' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: /workspace/i })).not.toBeInTheDocument();
  });

  it('dismisses the tree drawer before opening the import dialog', async () => {
    const user = userEvent.setup();
    stubViewport(false);
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /show the workspace tree/i }));
    expect(await screen.findByRole('complementary', { name: /workspace/i })).toBeVisible();

    await user.click(within(rail()).getByRole('button', { name: 'Import' }));

    expect(screen.getByRole('dialog', { name: 'Import' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: /workspace/i })).not.toBeInTheDocument();
  });
});
