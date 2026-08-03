import { useCallback } from 'react';
import { useSearchParams } from 'react-router';

import { usePaneIndex } from '../panes/pane-context';
import { paneParam } from '../panes/pane-params';
import { clearViewState } from '../views/view-state';

/**
 * Which item is open, held in the URL.
 *
 * The state ladder puts the URL above local state for anything that should survive a refresh or
 * be shareable, and "the note I am looking at" is the most shareable fact in a document
 * workspace. Holding it in a store instead would make every link to a note a link to the
 * application's front door.
 *
 * Selecting pushes rather than replaces, because Back meaning "the note I was reading" is what
 * everybody expects of a document application.
 *
 * **Which item, in which pane.** The pane comes from context, and outside any provider it is the
 * first - whose parameter is the plain `item` this has always used. So every existing link keeps
 * working and every existing caller is unchanged; a second pane simply addresses `item2`.
 */

export const SELECTED_ITEM_PARAM = 'item';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads one raw parameter value. Exported so it is testable without a router.
 *
 * A value that is not an identifier is dropped rather than passed on: the URL is the most hostile
 * runtime boundary there is, anybody can type into it, and a malformed one should leave the shell
 * with nothing open rather than sending a nonsense identifier to Core.
 */
export function parseSelectedItem(raw: string | null, pane = 0): string | null {
  if (raw === null || raw.length === 0) {
    return null;
  }

  if (!UUID.test(raw)) {
    console.warn(
      `Ignoring unrecognised "${paneParam(SELECTED_ITEM_PARAM, pane)}" search parameter:`,
      raw,
    );
    return null;
  }

  return raw;
}

/** The name of the parameter naming a pane's open item. */
export function selectedItemParam(pane: number): string {
  return paneParam(SELECTED_ITEM_PARAM, pane);
}

/** Builds the search string for an item, for use as a <Link> target. */
export function selectedItemSearch(itemId: string): string {
  return `?${new URLSearchParams({ [SELECTED_ITEM_PARAM]: itemId }).toString()}`;
}

export interface SelectedItemControl {
  readonly selectedId: string | null;
  readonly select: (itemId: string) => void;
  readonly clear: () => void;
}

export function useSelectedItem(): SelectedItemControl {
  const pane = usePaneIndex();
  const [searchParams, setSearchParams] = useSearchParams();
  const name = selectedItemParam(pane);
  const selectedId = parseSelectedItem(searchParams.get(name), pane);

  const select = useCallback(
    (itemId: string): void => {
      const next = new URLSearchParams(searchParams);

      // The view, sort and filters belonged to the item being left, and every item can carry views
      // of its own now. Left in place, opening a sibling that happens to have a view with the same
      // id would land on a board nobody asked for - and one that does not would look like the
      // choice had been ignored.
      //
      // Scoped to this pane. Unscoped, navigating here would clear the *other* pane's view too,
      // which is a change nobody asked for in a part of the screen they were not looking at.
      clearViewState(next, pane);
      next.set(name, itemId);
      setSearchParams(next);
    },
    [name, pane, searchParams, setSearchParams],
  );

  const clear = useCallback((): void => {
    const next = new URLSearchParams(searchParams);
    next.delete(name);
    setSearchParams(next, { replace: true });
  }, [name, searchParams, setSearchParams]);

  return { selectedId, select, clear };
}
