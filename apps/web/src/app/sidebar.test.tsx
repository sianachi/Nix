import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from './app';
import { item, stubCoreApi } from '../test/api-stub';
import { renderAt, signedIn } from '../test/render-with-router';
import { readCollapsed, storeCollapsed, STORAGE_KEY } from './use-sidebar';

/**
 * Collapsing the workspace tree.
 *
 * The part worth testing is not that it disappears - it is that it disappears *properly*. A tree
 * moved off-screen with a width of zero is still in the tab order and still in the accessibility
 * tree, so a keyboard walks through a sidebar nobody can see and a screen reader reads out a
 * workspace that is not on screen.
 */

let stored: Map<string, string>;

beforeEach(() => {
  signedIn();
  stored = new Map();

  // jsdom's own localStorage is inert here, so persistence assertions would pass vacuously.
  Object.defineProperty(globalThis.window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
      clear: () => {
        stored.clear();
      },
      key: (index: number) => [...stored.keys()][index] ?? null,
      get length() {
        return stored.size;
      },
    },
  });
});

const NOTE = item({ id: '3a3a3a3a-3333-4333-8333-3a3a3a3a3a3a', title: 'Roadmap' });

describe('the workspace tree', () => {
  it('is on screen until somebody hides it', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    expect(await screen.findByRole('complementary', { name: /workspace/i })).toBeVisible();
  });

  it('leaves the page entirely when hidden, not merely the view', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Roadmap' });
    await user.click(screen.getByRole('button', { name: /hide the workspace tree/i }));

    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: /workspace/i })).not.toBeInTheDocument();
    });

    // The rows go with it. Hidden with a width of zero they would still be tabbable.
    expect(screen.queryByRole('button', { name: 'Roadmap' })).not.toBeInTheDocument();
  });

  it('can be brought back, because the control is not inside it', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Roadmap' });
    await user.click(screen.getByRole('button', { name: /hide the workspace tree/i }));
    await user.click(await screen.findByRole('button', { name: /show the workspace tree/i }));

    expect(await screen.findByRole('button', { name: 'Roadmap' })).toBeVisible();
  });

  it('says which state it is in, for a screen reader', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    const toggle = await screen.findByRole('button', { name: /hide the workspace tree/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await user.click(toggle);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /show the workspace tree/i })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
    });
  });

  it('remembers being hidden', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Roadmap' });
    await user.click(screen.getByRole('button', { name: /hide the workspace tree/i }));

    // Somebody who collapses the tree has decided they want the width. Finding it back on the next
    // visit would make the control feel like it had not worked.
    await waitFor(() => {
      expect(stored.get(STORAGE_KEY)).toBe('collapsed');
    });
  });
});

describe('remembering the choice', () => {
  it('defaults to open when nothing has been chosen', () => {
    expect(readCollapsed(undefined)).toBe(false);
  });

  it('stores open as absence rather than as a second spelling', () => {
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    } as unknown as Storage;

    storeCollapsed(storage, true);
    expect(stored.get(STORAGE_KEY)).toBe('collapsed');

    storeCollapsed(storage, false);
    expect(stored.has(STORAGE_KEY)).toBe(false);
  });

  it('survives a browser that refuses storage', () => {
    const refusing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;

    expect(readCollapsed(refusing)).toBe(false);
    expect(() => {
      storeCollapsed(refusing, true);
    }).not.toThrow();
  });
});
