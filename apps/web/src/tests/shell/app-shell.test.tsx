import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { item, stubCoreApi } from '../api-stub';
import { renderAt, signedIn } from '../render-with-router';
import { App } from '../../app';

/**
 * The shell's information architecture.
 *
 * These are the assertions that keep the product's shape from drifting back towards the design
 * file's five example screens: no tab strip, no board page, no search page, and an administrative
 * entry that appears only because the server said so.
 */
beforeEach(() => {
  signedIn();
});

const NOTE = item({
  id: '1e1e1e1e-1111-4111-8111-1e1e1e1e1e1e',
  title: 'Acquisition memo',
});

describe('the shell', () => {
  it('has no tab strip, because a board and a search page are not destinations', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Acquisition memo' });

    // The old strip was Editor / Board / Search / Admin. None of them is a place any more.
    expect(screen.queryByRole('navigation', { name: /sections/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^board$/i })).not.toBeInTheDocument();
  });

  it('offers a skip link as the first thing a keyboard reaches', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Acquisition memo' });
    await user.tab();

    // It used to live on a layout element the route tree had stopped rendering,
    // so the app shipped with no skip link at all and nothing said so. Reaching
    // it by tabbing is the assertion; querying for the anchor would have passed
    // in the broken state too, had the element still been mounted anywhere.
    const skip = screen.getByRole('link', { name: /skip to content/i });
    expect(skip).toHaveFocus();
    expect(skip).toHaveAttribute('href', '#main');

    // And it must land somewhere: an anchor pointing at no such id is a skip
    // link that silently does nothing.
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
  });

  it('gives pane content its own stacking context, so nothing inside a pane can paint over the header', async () => {
    // A regression for the bug where the narrow-viewport drawer (`sidebar-drawer.tsx`) painted
    // over the profile menu: neither established a stacking context of its own, so both resolved
    // into the root context at the same z-index and the tie broke on DOM order. `isolate` here
    // means everything a pane renders - `sheet-grid.tsx`'s own layered overlays included - stays
    // contained below the header's popovers regardless of any z-index it picks for itself.
    //
    // This checks the class is present, not the paint order it produces: jsdom does not compile
    // Tailwind for this suite (`vite.config.ts`), so there is no stylesheet for a stacking context
    // to exist against here. See `sidebar-drawer.test.tsx`'s own comment on the same limit.
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    expect(await screen.findByRole('main')).toHaveClass('isolate');
  });

  it('keeps the workspace tree on screen rather than inside one page', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    expect(await screen.findByRole('button', { name: 'Acquisition memo' })).toBeVisible();
    expect(screen.getByRole('complementary', { name: /workspace/i })).toBeInTheDocument();
  });

  it('opens search over whatever is on screen, from a control that is always there', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await user.click(screen.getByRole('button', { name: /^search/i }));

    expect(screen.getByRole('dialog', { name: /search/i })).toBeInTheDocument();
  });

  it('opens search from the keyboard, wherever the caret is', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await user.keyboard('{Control>}k{/Control}');

    expect(screen.getByRole('dialog', { name: /search/i })).toBeInTheDocument();
  });

  it('closes search on Escape without navigating anywhere', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await user.click(screen.getByRole('button', { name: /^search/i }));
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /search/i })).not.toBeInTheDocument();
    });
  });

  it('finds a note by title and opens it', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Acquisition memo' });
    await user.click(screen.getByRole('button', { name: /^search/i }));
    await user.type(screen.getByRole('combobox', { name: /search items/i }), 'acquisition');

    // Awaited rather than read straight away: the search is debounced and answered by the server,
    // so a synchronous assertion here would be asserting on the empty list that precedes it.
    const dialog = screen.getByRole('dialog', { name: /search/i });
    const result = await within(dialog).findByRole('option', { name: /Acquisition memo/ });

    // And it opens: the palette closes and the note is what the pane now shows.
    await user.click(result);

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /search/i })).not.toBeInTheDocument();
    });
  });

  it('says a search failed rather than reporting an empty workspace', async () => {
    // The caveat this replaces - "matches titles of the notes loaded" - described a limitation
    // that no longer exists: the palette asks the server, which searches titles and document text
    // across every workspace the caller may read. What still has to be said out loud is the
    // failure, because a palette that reports nothing found when the request never succeeded sends
    // somebody off to recreate a document they already have.
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE], searchFails: true });
    renderAt(<App />);

    await user.click(screen.getByRole('button', { name: /^search/i }));
    await user.type(screen.getByRole('combobox', { name: /search items/i }), 'acquisition');

    expect(await screen.findByText(/could not be run/i)).toBeVisible();
  });

  it('offers commands beside the items it found', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await user.click(screen.getByRole('button', { name: /^search/i }));
    await user.type(screen.getByRole('combobox', { name: /search items/i }), 'note');

    // One list, ordered commands then items, so a single run of arrow keys walks the whole answer.
    expect(await screen.findByRole('option', { name: /New note/ })).toBeVisible();
  });

  it('creates a command-palette note at the workspace root even when another note is open', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, `/?item=${NOTE.id}`);

    await user.click(screen.getByRole('button', { name: /^search/i }));
    await user.type(screen.getByRole('combobox', { name: /search items/i }), 'note');
    await user.click(await screen.findByRole('option', { name: /New note/ }));

    const created = await screen.findByRole('button', { name: 'Untitled note' });
    expect(created.closest('ul')).toHaveAttribute('role', 'tree');
  });
});

describe('the profile menu', () => {
  it('shows who is signed in', async () => {
    const user = userEvent.setup();
    stubCoreApi({ displayName: 'Ada Lovelace', email: 'ada@example.test' });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /ada lovelace/i }));

    expect(screen.getByRole('menu', { name: /account/i })).toBeInTheDocument();
    expect(screen.getByText('ada@example.test')).toBeVisible();
  });

  it('always offers a way out', async () => {
    const user = userEvent.setup();
    stubCoreApi();
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /test person/i }));

    expect(screen.getByRole('menuitem', { name: /sign out/i })).toBeInTheDocument();
  });

  it('says so when the profile could not be loaded instead of pretending it has one', async () => {
    const user = userEvent.setup();
    stubCoreApi({ profileFails: true });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /loading|profile/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/profile could not be loaded/i);
  });
});
