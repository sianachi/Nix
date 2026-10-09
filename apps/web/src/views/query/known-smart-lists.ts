import { useEffect } from 'react';
import { z } from 'zod';
import { create } from 'zustand';

import { browserStorage } from '../../lib/browser-storage';
import { onItemChildrenChanged } from '../../lib/item-children-changed';
import type { ContainerViews } from '../core/container-model';

/**
 * The smart lists this browser knows about in each workspace, for the rail's Queries section
 * (plan 1.8) - each an item whose default view is a `query`.
 *
 * **Learned, not listed.** Core has no read for "every item whose default view is a query", and
 * this lane adds no endpoint (plan 1.8 is pure web), so the list is what this browser has seen:
 * an item opened whose default view turns out to be a query is remembered, one that has since
 * stopped being one is forgotten, a deleted one is dropped, and one made from the rail's "New
 * query" is remembered as it is opened. The rail says so in its own copy rather than presenting
 * the list as the workspace's complete set. A Core read lands with the query endpoint (plan 1.1),
 * and this store is what it replaces.
 *
 * **Pinning is a person's arrangement of their own rail**, so it is browser-local like the page
 * guides and the panel width, not a write to the item that everybody would see.
 */

export interface KnownSmartList {
  readonly id: string;
  readonly title: string;
  readonly pinned: boolean;
}

const KEY = 'nix.known-smart-lists';
const MAXIMUM_REMEMBERED = 50;

const storedSchema = z.record(
  z.string(),
  z.array(z.object({ id: z.string(), title: z.string(), pinned: z.boolean() })),
);

type Known = Readonly<Record<string, readonly KnownSmartList[]>>;

function readKnown(storage: Storage | undefined): Known {
  try {
    const raw = storage?.getItem(KEY);
    if (raw === null || raw === undefined) return {};
    const parsed = storedSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function writeKnown(known: Known): void {
  try {
    browserStorage()?.setItem(KEY, JSON.stringify(known));
  } catch {
    /* Still known for this session; the rail works without storage. */
  }
}

interface KnownSmartListsStore {
  readonly known: Known;
  readonly remember: (workspaceId: string, id: string, title: string) => void;
  readonly forget: (workspaceId: string, ids: readonly string[]) => void;
  readonly setPinned: (workspaceId: string, id: string, pinned: boolean) => void;
}

export const useKnownSmartListsStore = create<KnownSmartListsStore>((set, get) => {
  const update = (workspaceId: string, next: readonly KnownSmartList[]): void => {
    const known = { ...get().known, [workspaceId]: next };
    writeKnown(known);
    set({ known });
  };

  return {
    known: readKnown(browserStorage()),
    remember: (workspaceId, id, title) => {
      const current = get().known[workspaceId] ?? [];
      const existing = current.find((entry) => entry.id === id);
      if (existing?.title === title) return;
      // Newest first among the unpinned, so the rail's list is the recent ones when it is long.
      const next =
        existing === undefined
          ? [{ id, title, pinned: false }, ...current].slice(0, MAXIMUM_REMEMBERED)
          : current.map((entry) => (entry.id === id ? { ...entry, title } : entry));
      update(workspaceId, next);
    },
    forget: (workspaceId, ids) => {
      const current = get().known[workspaceId] ?? [];
      const next = current.filter((entry) => !ids.includes(entry.id));
      if (next.length !== current.length) update(workspaceId, next);
    },
    setPinned: (workspaceId, id, pinned) => {
      const current = get().known[workspaceId] ?? [];
      update(
        workspaceId,
        current.map((entry) => (entry.id === id ? { ...entry, pinned } : entry)),
      );
    },
  };
});

const NONE: readonly KnownSmartList[] = [];

/** One workspace's known smart lists, pinned first and otherwise in the order they were met. */
export function useKnownSmartLists(workspaceId: string): readonly KnownSmartList[] {
  const lists = useKnownSmartListsStore((state) => state.known[workspaceId] ?? NONE);
  return [...lists.filter((entry) => entry.pinned), ...lists.filter((entry) => !entry.pinned)];
}

/**
 * Remembers an opened item as a smart list while its default view is a query, and forgets it once
 * it is not. Called where an item is opened with its title and its views both in hand.
 */
export function useRememberSmartList(
  workspaceId: string | null,
  itemId: string,
  title: string,
  views: ContainerViews | null,
): void {
  const defaultKind =
    views === null ? null : (views.views.find((view) => view.id === views.default)?.kind ?? '');
  useEffect(() => {
    if (defaultKind === null || workspaceId === null) return;
    const store = useKnownSmartListsStore.getState();
    if (defaultKind === 'query') {
      store.remember(workspaceId, itemId, title);
    } else {
      store.forget(workspaceId, [itemId]);
    }
  }, [defaultKind, itemId, title, workspaceId]);
}

/** Drops deleted items from the known lists, wherever the deletion happened. */
export function useForgetDeletedSmartLists(): void {
  useEffect(
    () =>
      onItemChildrenChanged((detail) => {
        if (detail.removedItemIds.length > 0) {
          useKnownSmartListsStore.getState().forget(detail.workspaceId, detail.removedItemIds);
        }
      }),
    [],
  );
}
