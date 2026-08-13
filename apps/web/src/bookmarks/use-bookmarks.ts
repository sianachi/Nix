import { shelfSchema, type KeptItem } from '@nix/api-client';
import { useEffect } from 'react';
import { create } from 'zustand';

import { useAuth } from '../auth/auth-provider';

/**
 * What the reader has kept, held once for the whole application.
 *
 * **A store rather than a hook per caller, and that is the whole design.** Four places care about
 * this at the same time: the shelf page, the tree's rows, the open document's control, and the
 * command palette. A hook fetching per caller would mean four requests on one screen and, worse,
 * four answers - keeping something from the tree would leave the editor's control still saying
 * "Keep", because nothing told it. One store, one truth, every reader of it correct at once.
 *
 * **Writes are optimistic, and they undo themselves on failure.** Keeping something is a two-state
 * toggle a reader presses and moves on from; waiting for a round trip to redraw a star makes the
 * control feel broken on a slow link. So the set changes first and the request follows, and a
 * refusal puts it back rather than leaving a star lit over a bookmark that does not exist.
 */

export interface BookmarksState {
  readonly status: 'loading' | 'ready' | 'error';

  /** The kept items, most recently kept first. */
  readonly items: readonly KeptItem[];

  /**
   * Which item identifiers are kept, for the controls that only need to ask.
   *
   * Derived from `items` and held beside it, because a star on every tree row asking
   * `items.some(...)` would be a linear scan per row per render.
   */
  readonly keptIds: ReadonlySet<string>;

  /** How many kept items cannot currently be shown. Never named - see the schema for why. */
  readonly hidden: number;

  readonly error: string | null;
}

interface BookmarksStore extends BookmarksState {
  readonly reload: () => Promise<void>;
  readonly keep: (itemId: string) => Promise<void>;
  readonly release: (itemId: string) => Promise<void>;
  readonly toggle: (itemId: string) => Promise<void>;
}

/** Rebuilds the derived set whenever the list changes, so the two cannot disagree. */
function idsOf(items: readonly KeptItem[]): ReadonlySet<string> {
  return new Set(items.map((item) => item.itemId));
}

/**
 * How the store gets a bearer token.
 *
 * **Registered by the shell rather than read with `useAuth`, and that is the point.** The star
 * appears on every tree row and in the editor's chrome, so if reaching the server needed React
 * context then every one of those components - and every test that renders one - would need an
 * `AuthProvider` above it. A control that shows whether something is bookmarked has no business
 * requiring an identity provider to render.
 *
 * Module state rather than store state because it is not data: nothing re-renders when it changes,
 * and putting it in the store would invite a selector to subscribe to a function.
 */
let readToken: (() => Promise<string | null>) | null = null;

async function request(path: string, method: string): Promise<Response> {
  const token = readToken === null ? null : await readToken();

  return fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
  });
}

export const useBookmarksStore = create<BookmarksStore>((set, get) => ({
  status: 'loading',
  items: [],
  keptIds: new Set<string>(),
  hidden: 0,
  error: null,

  reload: async () => {
    try {
      const response = await request('/api/v1/me/bookmarks', 'GET');
      if (!response.ok) {
        set({
          status: 'error',
          items: [],
          keptIds: new Set<string>(),
          hidden: 0,
          error:
            response.status === 404
              ? 'This version of the application asked for a shelf the server does not offer. The server may be running an older build.'
              : 'The server refused the request.',
        });
        return;
      }

      const parsed = shelfSchema.safeParse(await response.json());
      if (!parsed.success) {
        set({
          status: 'error',
          items: [],
          keptIds: new Set<string>(),
          hidden: 0,
          error: 'Your bookmarks came back in a shape this version does not understand.',
        });
        return;
      }

      set({
        status: 'ready',
        items: parsed.data.items,
        keptIds: idsOf(parsed.data.items),
        hidden: Number(parsed.data.hidden),
        error: null,
      });
    } catch {
      set({
        status: 'error',
        items: [],
        keptIds: new Set<string>(),
        hidden: 0,
        error: 'The server could not be reached.',
      });
    }
  },

  keep: async (itemId) => {
    // Optimistic. Keeping is a two-state toggle somebody presses and moves on from, and waiting for
    // a round trip to fill in a star makes the control feel broken on a slow link.
    const before = get().keptIds;
    if (!before.has(itemId)) {
      const next = new Set(before);
      next.add(itemId);
      set({ keptIds: next });
    }

    try {
      const response = await request(`/api/v1/items/${itemId}/bookmark`, 'PUT');
      if (!response.ok) {
        set({ keptIds: before });
        return;
      }

      // Re-read rather than synthesising a row. The list carries the item's title and workspace and
      // this build has neither, so an invented row would put a name on the shelf that came from
      // nowhere.
      await get().reload();
    } catch {
      set({ keptIds: before });
    }
  },

  release: async (itemId) => {
    const beforeIds = get().keptIds;
    const beforeItems = get().items;

    const next = new Set(beforeIds);
    next.delete(itemId);
    set({ keptIds: next, items: beforeItems.filter((item) => item.itemId !== itemId) });

    try {
      const response = await request(`/api/v1/items/${itemId}/bookmark`, 'DELETE');
      if (!response.ok) {
        // Put it back. The optimistic removal was a guess and the guess was wrong; leaving it off
        // would show a shelf missing something the server still holds.
        set({ keptIds: beforeIds, items: beforeItems });
      }
    } catch {
      set({ keptIds: beforeIds, items: beforeItems });
    }
  },

  toggle: async (itemId) => {
    const state = get();
    await (state.keptIds.has(itemId) ? state.release(itemId) : state.keep(itemId));
  },
}));

/** Whether one item is on the shelf. A selector, so a row re-renders only when its own answer moves. */
export function useIsKept(itemId: string | null): boolean {
  return useBookmarksStore((state) => (itemId === null ? false : state.keptIds.has(itemId)));
}

/**
 * Loads the shelf once, and tells the store how to authenticate.
 *
 * Called by the shell, which is the one place that both has the auth context and mounts once. Every
 * other holder of a bookmark control reads and writes through the store without knowing an identity
 * provider exists.
 */
export function useBookmarksLoader(): void {
  const { getAccessToken } = useAuth();
  const reload = useBookmarksStore((state) => state.reload);

  useEffect(() => {
    readToken = getAccessToken;
  }, [getAccessToken]);

  // Deferred a microtask, the same way `use-current-principal.ts` defers its own first read: the
  // load sets store state, and doing that synchronously inside an effect body is the cascading
  // render `react-hooks/set-state-in-effect` exists to stop.
  useEffect(() => {
    queueMicrotask(() => {
      void reload();
    });
  }, [reload]);
}
