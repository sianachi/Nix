import { create } from 'zustand';

/**
 * Which documents are open in each pane's tab strip, held in memory rather than the address.
 *
 * **Not the address, on purpose.** Every other multi-document fact in this shell - which panes are
 * open, their split, their sizes - lives in the URL, `pane-state.ts` argues, so a link somebody
 * pastes reproduces exactly what they saw. A tab strip several documents deep does not have that
 * property to protect: it is a working set, closer to a browser's own tab strip than to a fact
 * worth sending someone. Encoding it into the query string would also mean every preview-tab
 * replacement and every reorder became a navigation entry, which Back does not agree is what
 * happened. So this is the next rung down the state ladder - a Zustand slice, session-local, gone
 * on refresh - and `pane.itemId` from `usePanes()` stays the one thing that is still in the address:
 * "what a pane shows" is shareable, "what else is open behind it" is not.
 *
 * **No `activeId` field.** The active tab for a pane is `pane.itemId`, exactly as it is today.
 * Keeping a second copy here would hand this store and the URL two answers to the same question,
 * which is the drift `pane-state.ts`'s own doc comments are careful to avoid everywhere else. This
 * store only answers "what's in the strip" - the caller compares each tab's `itemId` against the
 * pane's own `itemId` to know which one is showing.
 *
 * Actions are named as events, matching `session-store.ts`.
 */

export interface OpenTab {
  readonly itemId: string;
  /** Preview tabs are replaced by the next preview; pinned ones are not. */
  readonly pinned: boolean;
}

interface TabsState {
  readonly workspaceId: string | null;
  readonly byPane: Readonly<Record<number, readonly OpenTab[]>>;

  /** A routed workspace changed, so no document working set can cross the boundary. */
  readonly workspaceChanged: (workspaceId: string) => void;

  /**
   * A document became the only addressed pane.
   *
   * Destination routes and hidden-pane opens both collapse to one visible pane. Only pane zero can
   * be resumed without inventing which document was active elsewhere, so its working set is kept
   * while tabs belonging to now-unaddressed panes are dropped. A later history navigation can
   * restore those addresses, but not revive duplicate document ownership from the session store.
   */
  readonly itemOpenedAlone: (itemId: string, pinned: boolean) => void;

  /**
   * A document was opened lightly - a sidebar click, a breadcrumb, a link. Reuses the pane's
   * existing preview tab if it has one, in place, rather than moving it to the end of the strip;
   * appends a new one otherwise. A no-op when the document is already pinned in this pane - an
   * already-committed tab does not get demoted by a passing click.
   */
  readonly tabPreviewed: (pane: number, itemId: string) => void;

  /**
   * A document was committed to - double-click, editing its title, or explicitly opening it
   * beside. Promotes it in place if it is already open in this pane (previewed or otherwise);
   * inserts it pinned at the end if it is not open here yet.
   */
  readonly tabPinned: (pane: number, itemId: string) => void;

  /**
   * A tab in a pane was activated. Claims its global ownership for that pane without announcing
   * or moving focus away from the tablist, preserving whether it was already pinned.
   */
  readonly tabActivated: (pane: number, itemId: string) => void;

  /**
   * A cross-pane move installed one already-validated, globally unique working set.
   *
   * The transfer planner owns the multi-pane arithmetic because it must change the URL and this
   * store from the same materialized strips. This event keeps the store mutation atomic rather
   * than composing pin, close and pane-close events that each observe a different intermediate
   * owner.
   */
  readonly tabsTransferred: (nextByPane: Readonly<Record<number, readonly OpenTab[]>>) => void;

  /**
   * Removes one document from every pane's working set. Ownership is globally unique, and a stale
   * record may still sit under its former pane after Back restores an older address.
   */
  readonly tabClosed: (itemId: string) => void;

  /**
   * A pane closed. Mirrors `closePaneParams`/`shiftPane` in `pane-params.ts` exactly: the closed
   * pane's tabs are dropped, and every pane after it moves down one index. Has to be called from
   * the same site that closes the pane in the address, or the two renumberings fall out of step
   * and a pane's tab strip silently belongs to whichever pane used to sit at that index.
   */
  readonly paneClosed: (index: number, count: number) => void;
}

/** Applies the one-preview-tab rule without knowing which pane owns the list. */
function previewTabs(tabs: readonly OpenTab[], itemId: string): readonly OpenTab[] {
  const existing = tabs.find((tab) => tab.itemId === itemId);
  if (existing !== undefined) {
    return tabs;
  }

  const previewIndex = tabs.findIndex((tab) => !tab.pinned);
  if (previewIndex === -1) {
    return [...tabs, { itemId, pinned: false }];
  }

  return tabs.map((tab, index) => (index === previewIndex ? { itemId, pinned: false } : tab));
}

/** Promotes or appends one tab without knowing which pane owns the list. */
function pinTabs(tabs: readonly OpenTab[], itemId: string): readonly OpenTab[] {
  const index = tabs.findIndex((tab) => tab.itemId === itemId);
  if (index === -1) {
    return [...tabs, { itemId, pinned: true }];
  }

  if (tabs[index]?.pinned === true) {
    return tabs;
  }

  return tabs.map((tab, offset) => (offset === index ? { itemId, pinned: true } : tab));
}

export function itemIsPinned(
  byPane: Readonly<Record<number, readonly OpenTab[]>>,
  itemId: string,
): boolean {
  return Object.values(byPane).some((tabs) =>
    tabs.some((tab) => tab.itemId === itemId && tab.pinned),
  );
}

/** Moves one document's session-local ownership to a pane and removes every stale copy. */
function claimItem(
  byPane: Readonly<Record<number, readonly OpenTab[]>>,
  pane: number,
  itemId: string,
  claimedTabs: readonly OpenTab[],
): Readonly<Record<number, readonly OpenTab[]>> {
  const next: Record<number, readonly OpenTab[]> = {};

  for (const [key, tabs] of Object.entries(byPane)) {
    const index = Number(key);
    next[index] = index === pane ? claimedTabs : tabs.filter((tab) => tab.itemId !== itemId);
  }
  next[pane] = claimedTabs;

  return next;
}

export const useTabStore = create<TabsState>((set) => ({
  workspaceId: null,
  byPane: {},

  workspaceChanged: (workspaceId) => {
    set((state) => (state.workspaceId === workspaceId ? state : { workspaceId, byPane: {} }));
  },

  itemOpenedAlone: (itemId, pinned) => {
    set((state) => {
      const tabs = state.byPane[0] ?? [];
      const wasPinned = itemIsPinned(state.byPane, itemId);
      const committed = pinned || wasPinned;
      const next = committed ? pinTabs(tabs, itemId) : previewTabs(tabs, itemId);

      return { byPane: { 0: next } };
    });
  },

  tabPreviewed: (pane, itemId) => {
    set((state) => {
      const tabs = state.byPane[pane] ?? [];
      const next = itemIsPinned(state.byPane, itemId)
        ? pinTabs(tabs, itemId)
        : previewTabs(tabs, itemId);

      return { byPane: claimItem(state.byPane, pane, itemId, next) };
    });
  },

  tabPinned: (pane, itemId) => {
    set((state) => {
      const tabs = state.byPane[pane] ?? [];
      const next = pinTabs(tabs, itemId);

      return { byPane: claimItem(state.byPane, pane, itemId, next) };
    });
  },

  tabActivated: (pane, itemId) => {
    set((state) => {
      const tabs = state.byPane[pane] ?? [];
      const next = itemIsPinned(state.byPane, itemId)
        ? pinTabs(tabs, itemId)
        : previewTabs(tabs, itemId);

      return { byPane: claimItem(state.byPane, pane, itemId, next) };
    });
  },

  tabsTransferred: (nextByPane) => {
    set({ byPane: nextByPane });
  },

  tabClosed: (itemId) => {
    set((state) => {
      const next: Record<number, readonly OpenTab[]> = {};
      for (const [key, tabs] of Object.entries(state.byPane)) {
        next[Number(key)] = tabs.filter((tab) => tab.itemId !== itemId);
      }
      return { byPane: next };
    });
  },

  paneClosed: (index, count) => {
    set((state) => {
      const next: Record<number, readonly OpenTab[]> = {};

      // Rebuilt rather than mutated: every pane before the closed one keeps its index, the closed
      // one is left out, and every pane after it - up to `count`, the same bound
      // `closePaneParams` shifts within - moves down one. A pane index past `count` is left
      // exactly where it was, the same as `closePaneParams` leaves the address's own stray
      // parameters alone.
      for (const [key, tabs] of Object.entries(state.byPane)) {
        const from = Number(key);
        if (from === index) {
          continue;
        }

        const to = from > index && from < count ? from - 1 : from;
        next[to] = tabs;
      }

      return { byPane: next };
    });
  },
}));
