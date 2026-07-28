import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '../app/app';
import { item, stubCoreApi } from '../test/api-stub';
import { renderAt, signedIn } from '../test/render-with-router';

/**
 * Applying a template, all the way through.
 *
 * The templates had tests against a stand-in container, which proved `applyTemplate` sends the right
 * two writes and nothing about whether the screen then changes. This walks the path somebody
 * actually takes: open the panel, pick a template, and look at what is on screen afterwards.
 */

beforeEach(() => {
  signedIn();

  Object.defineProperty(globalThis.window, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    },
  });
});

const PARENT = item({
  id: '6a6a6a6a-6666-4666-8666-6a6a6a6a6a6a',
  title: 'Roadmap',
  hasChildren: true,
});

const CHILD = item({
  id: '6b6b6b6b-6666-4666-8666-6b6b6b6b6b6b',
  title: 'Q1 planning',
  parentId: PARENT.id,
});

async function applyKanban(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: /settings/i }));

  const panel = await screen.findByRole('complementary', { name: /item settings/i });
  await user.click(within(panel).getByRole('button', { name: 'Views' }));
  await user.click(await within(panel).findByRole('button', { name: /kanban board/i }));
}

describe('applying a template', () => {
  it('shows the item as a board afterwards, not as a note', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [PARENT, CHILD] });
    renderAt(<App />, `/?item=${PARENT.id}`);

    await applyKanban(user);

    // The whole point of applying it. The item opened on its document before, and the template
    // sets the board as what opens - so the children are what is on screen now.
    await waitFor(() => {
      expect(screen.getByRole('navigation', { name: /views/i })).toBeInTheDocument();
    });

    const switcher = screen.getByRole('navigation', { name: /views/i });
    expect(within(switcher).getByRole('button', { name: /board/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('draws the children rather than the body', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [PARENT, CHILD] });
    renderAt(<App />, `/?item=${PARENT.id}`);

    await applyKanban(user);

    // A card for the child, which only the board draws. The document body would show the editor.
    expect(await screen.findByRole('region', { name: 'To do' })).toBeInTheDocument();
  });

  it('keeps the field it declared', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [PARENT, CHILD] });
    renderAt(<App />, `/?item=${PARENT.id}`);

    await applyKanban(user);

    // The board groups by the Status the template declared. Without the schema write landing, the
    // board would report itself unrenderable instead.
    await waitFor(() => {
      expect(screen.queryByText(/cannot be drawn/i)).not.toBeInTheDocument();
    });
  });
});

describe('adding a view by hand', () => {
  it('opens the item on the first view it is given', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [PARENT, CHILD] });
    renderAt(<App />, `/?item=${PARENT.id}`);

    await user.click(await screen.findByRole('button', { name: /settings/i }));
    const panel = await screen.findByRole('complementary', { name: /item settings/i });
    await user.click(within(panel).getByRole('button', { name: 'Views' }));

    await user.click(await within(panel).findByRole('button', { name: /add a view/i }));
    await user.click(within(panel).getByRole('button', { name: /save views/i }));

    // Building your first view and having the screen not change is the whole of the bug this
    // covers. At the moment it is made, "the document" was never a choice - it was the only option
    // - so the first view an item is given is what it opens on.
    await waitFor(() => {
      expect(screen.getByRole('navigation', { name: /views/i })).toBeInTheDocument();
    });

    const switcher = screen.getByRole('navigation', { name: /views/i });
    expect(within(switcher).getByRole('button', { name: /document/i })).not.toHaveAttribute(
      'aria-current',
    );
  });
});
