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
  readonly byPane: Readonly<Record<number, readonly OpenTab[]>>;

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
   * Removes one tab from a pane's strip. Deciding what to activate next, or whether closing the
   * last tab should close the pane itself, is the caller's job - this stays a pure list edit, the
   * same division `pane-state.ts`'s `closePane` keeps from its own side effects.
   */
  readonly tabClosed: (pane: number, itemId: string) => void;

  /**
   * A pane closed. Mirrors `closePaneParams`/`shiftPane` in `pane-params.ts` exactly: the closed
   * pane's tabs are dropped, and every pane after it moves down one index. Has to be called from
   * the same site that closes the pane in the address, or the two renumberings fall out of step
   * and a pane's tab strip silently belongs to whichever pane used to sit at that index.
   */
  readonly paneClosed: (index: number, count: number) => void;
}

export const useTabStore = create<TabsState>((set) => ({
  byPane: {},

  tabPreviewed: (pane, itemId) => {
    set((state) => {
      const tabs = state.byPane[pane] ?? [];
      const existing = tabs.find((tab) => tab.itemId === itemId);
      if (existing?.pinned === true) {
        return state;
      }

      const previewIndex = tabs.findIndex((tab) => !tab.pinned);
      const next = [...tabs];
      if (previewIndex === -1) {
        next.push({ itemId, pinned: false });
      } else {
        next[previewIndex] = { itemId, pinned: false };
      }

      return { byPane: { ...state.byPane, [pane]: next } };
    });
  },

  tabPinned: (pane, itemId) => {
    set((state) => {
      const tabs = state.byPane[pane] ?? [];
      const index = tabs.findIndex((tab) => tab.itemId === itemId);

      if (index === -1) {
        return { byPane: { ...state.byPane, [pane]: [...tabs, { itemId, pinned: true }] } };
      }

      if (tabs[index]?.pinned === true) {
        return state;
      }

      const next = [...tabs];
      next[index] = { itemId, pinned: true };
      return { byPane: { ...state.byPane, [pane]: next } };
    });
  },

  tabClosed: (pane, itemId) => {
    set((state) => {
      const tabs = state.byPane[pane] ?? [];
      return {
        byPane: { ...state.byPane, [pane]: tabs.filter((tab) => tab.itemId !== itemId) },
      };
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
