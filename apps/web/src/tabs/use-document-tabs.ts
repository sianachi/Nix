import { useTabStore, type OpenTab } from './tab-store';

/**
 * The tab strip a pane actually draws.
 *
 * **Derived, not written on mount.** A fresh load, a refresh, a link, or a brand-new pane from
 * `openBeside` all arrive with an active item the tab store has never heard of - `tab-store.ts`'s
 * own doc comment is explicit that this is the honest cost of keeping the strip out of the URL.
 * Writing that item into the store from a mount effect would work, but it is a write during
 * render's shadow (an effect that exists only to keep two copies of the same fact in step) for a
 * fact this hook can simply compute instead: if the pane's active item is not already one of its
 * tabs, append it as an unpinned one. A durable store write happens only when something actually
 * navigates - `use-open-item.ts`'s `openPreview`/`openPinned`/`openBeside`.
 */
export interface DocumentTabsResult {
  readonly tabs: readonly OpenTab[];
}

export function useDocumentTabs(paneIndex: number, activeItemId: string): DocumentTabsResult {
  const stored = useTabStore((state) => state.byPane[paneIndex]) ?? [];

  if (stored.some((tab) => tab.itemId === activeItemId)) {
    return { tabs: stored };
  }

  return { tabs: [...stored, { itemId: activeItemId, pinned: false }] };
}
