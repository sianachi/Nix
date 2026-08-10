import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { item, stubCoreApi } from '../api-stub';
import { renderAt, signedIn } from '../render-with-router';
import { stubViewport } from '../stub-viewport';
import { App } from '../../app';

/**
 * The navigation rail: the destinations that are not a document.
 *
 * Driven through the whole application rather than the component in isolation, because half of
 * what the rail promises is only true in a router - which link the URL makes current, and what
 * following one does to the address. The rail's own keyboard contract is asserted here too, on
 * the real links, since a roving tabindex is a claim about the document's tab order and nothing
 * short of tabbing through it checks that.
 */
beforeEach(() => {
  signedIn();
});

const NOTE = item({
  id: '1e1e1e1e-1111-4111-8111-1e1e1e1e1e1e',
  title: 'Acquisition memo',
});

function rail(): HTMLElement {
  return screen.getByRole('navigation', { name: /destinations/i });
}

describe('the navigation rail', () => {
  it('offers three named destinations, so an icon is never the only thing a link says', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Acquisition memo' });

    const links = within(rail()).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['Calendar', 'Graph', 'Bookmarks']);
    expect(within(rail()).getByRole('link', { name: 'Calendar' })).toHaveAttribute(
      'href',
      '/calendar',
    );
  });

  it('costs one Tab press to enter and one to leave, however many destinations it holds', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, '/calendar');

    await screen.findByRole('heading', { name: 'Calendar' });

    const calendar = within(rail()).getByRole('link', { name: 'Calendar' });
    const graph = within(rail()).getByRole('link', { name: 'Graph' });
    const bookmarks = within(rail()).getByRole('link', { name: 'Bookmarks' });

    // Only the entry point is in the tab order; the other two are reachable by arrow key alone.
    expect(calendar).toHaveAttribute('tabindex', '0');
    expect(graph).toHaveAttribute('tabindex', '-1');
    expect(bookmarks).toHaveAttribute('tabindex', '-1');

    // Tab reaches the skip link, then the rail, then leaves it - three destinations, one stop.
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

    const calendar = within(rail()).getByRole('link', { name: 'Calendar' });
    const graph = within(rail()).getByRole('link', { name: 'Graph' });
    const bookmarks = within(rail()).getByRole('link', { name: 'Bookmarks' });

    calendar.focus();

    await user.keyboard('{ArrowDown}');
    expect(graph).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(bookmarks).toHaveFocus();

    // Nothing wraps: the ends of the rail are meant to be findable by feel.
    await user.keyboard('{ArrowDown}');
    expect(bookmarks).toHaveFocus();

    await user.keyboard('{Home}');
    expect(calendar).toHaveFocus();

    await user.keyboard('{ArrowUp}');
    expect(calendar).toHaveFocus();

    await user.keyboard('{End}');
    expect(bookmarks).toHaveFocus();
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

  it('claims no current destination while a document is open, because none of them is where you are', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Acquisition memo' });

    for (const link of within(rail()).getAllByRole('link')) {
      expect(link).not.toHaveAttribute('aria-current');
    }
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

  it('says the destination is not built rather than showing an empty one that looks built', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, '/calendar');

    expect(await screen.findByRole('status')).toHaveTextContent(/not built yet/i);
  });
});

/**
 * jsdom lays nothing out, so what a narrow viewport means here is the code path
 * `use-narrow-viewport.ts` takes when its window query does not match - the same technique, and
 * the same helper, `sidebar.test.tsx` uses for the drawer.
 */
describe('the navigation rail on a narrow screen', () => {
  it('stays at the left edge, because nothing else in the shell reaches these destinations', async () => {
    stubViewport(false);
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await screen.findByRole('button', { name: /show the workspace tree/i });
    expect(within(rail()).getAllByRole('link')).toHaveLength(3);
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
});
