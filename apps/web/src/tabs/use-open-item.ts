import { useCallback } from 'react';
import { useSearchParams } from 'react-router';

import { announce } from '../app/announcer';
import { usePaneIndex } from '../panes/pane-context';
import { focusPane } from '../panes/pane-params';
import { usePanes, type BesideRefusal } from '../panes/pane-state';
import { useSelectedItem, writeSelectedItem } from '../routing/selected-item';
import { useTabStore } from './tab-store';

/**
 * The one door a document is opened through - previewed, pinned, or opened beside - and the
 * place cross-pane deduplication lives.
 *
 * **Why this exists rather than calling `useSelectedItem`/`usePanes` directly.** Those two only
 * know about the *active* item in each pane; once a pane can hold several backgrounded tabs, a
 * document can be open without being any pane's current `itemId`. Clicking a sidebar row for a
 * document that is sitting in pane 2's tab strip, backgrounded, has to focus pane 2 and switch it
 * there - not open a second copy in pane 0, which is what `useSelectedItem().select` alone would
 * do, and a second copy is exactly the "two `Y.Doc`s for one document" problem `pane-state.ts`'s
 * `openBeside` already exists to avoid for the active-item case.
 */

export interface OpenItemControl {
  /** A light-touch open - a sidebar click, a breadcrumb, an in-document link. Previews. */
  readonly openPreview: (itemId: string) => void;

  /** A committed open - a double-click, or promoting an existing tab. Pins. */
  readonly openPinned: (itemId: string) => void;

  /** Opens in another pane, pinned immediately - an explicit "beside" is already deliberate. */
  readonly openBeside: (itemId: string) => number | null;

  readonly canOpenBeside: boolean;
  readonly besideRefusal: BesideRefusal | null;
}

export function useOpenItem(): OpenItemControl {
  const pane = usePaneIndex();
  const { select } = useSelectedItem();
  const paneControl = usePanes();
  const [searchParams, setSearchParams] = useSearchParams();
  const byPane = useTabStore((state) => state.byPane);
  const tabPreviewed = useTabStore((state) => state.tabPreviewed);
  const tabPinned = useTabStore((state) => state.tabPinned);

  /** Which pane already has this document open, active or backgrounded - null if none does. */
  const locate = useCallback(
    (itemId: string): number | null => {
      const active = paneControl.panes.find((candidate) => candidate.itemId === itemId);
      if (active !== undefined) {
        return active.index;
      }

      for (const [key, tabs] of Object.entries(byPane)) {
        if (tabs.some((tab) => tab.itemId === itemId)) {
          return Number(key);
        }
      }

      return null;
    },
    [paneControl.panes, byPane],
  );

  /** Makes an already-open document the pane's active tab and moves focus there. */
  const focusExisting = useCallback(
    (foundPane: number, itemId: string): void => {
      const alreadyActive = paneControl.panes.some(
        (candidate) => candidate.index === foundPane && candidate.itemId === itemId,
      );

      if (!alreadyActive) {
        const next = new URLSearchParams(searchParams);
        writeSelectedItem(next, foundPane, itemId);
        setSearchParams(next);
      }

      announce(`Already open in pane ${String(foundPane + 1)}.`);
      focusPane(foundPane);
    },
    [paneControl.panes, searchParams, setSearchParams],
  );

  const openPreview = useCallback(
    (itemId: string): void => {
      const found = locate(itemId);
      if (found !== null) {
        focusExisting(found, itemId);
        return;
      }

      select(itemId);
      tabPreviewed(pane, itemId);
    },
    [locate, focusExisting, select, tabPreviewed, pane],
  );

  const openPinned = useCallback(
    (itemId: string): void => {
      const found = locate(itemId);
      if (found !== null) {
        focusExisting(found, itemId);
        tabPinned(found, itemId);
        return;
      }

      select(itemId);
      tabPinned(pane, itemId);
    },
    [locate, focusExisting, select, tabPinned, pane],
  );

  const openBeside = useCallback(
    (itemId: string): number | null => {
      const found = locate(itemId);
      if (found !== null) {
        focusExisting(found, itemId);
        tabPinned(found, itemId);
        return found;
      }

      const index = paneControl.openBeside(itemId);
      if (index !== null) {
        tabPinned(index, itemId);
      }
      return index;
    },
    [locate, focusExisting, tabPinned, paneControl],
  );

  return {
    openPreview,
    openPinned,
    openBeside,
    canOpenBeside: paneControl.canOpenBeside,
    besideRefusal: paneControl.besideRefusal,
  };
}
