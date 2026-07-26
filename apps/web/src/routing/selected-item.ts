import { useCallback } from 'react';
import { useSearchParams } from 'react-router';

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
export function parseSelectedItem(raw: string | null): string | null {
  if (raw === null || raw.length === 0) {
    return null;
  }

  if (!UUID.test(raw)) {
    console.warn(`Ignoring unrecognised "${SELECTED_ITEM_PARAM}" search parameter:`, raw);
    return null;
  }

  return raw;
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
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = parseSelectedItem(searchParams.get(SELECTED_ITEM_PARAM));

  const select = useCallback(
    (itemId: string): void => {
      const next = new URLSearchParams(searchParams);
      next.set(SELECTED_ITEM_PARAM, itemId);
      setSearchParams(next);
    },
    [searchParams, setSearchParams],
  );

  const clear = useCallback((): void => {
    const next = new URLSearchParams(searchParams);
    next.delete(SELECTED_ITEM_PARAM);
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  return { selectedId, select, clear };
}
