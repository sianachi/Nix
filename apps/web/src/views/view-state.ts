import { useCallback } from 'react';
import { useSearchParams } from 'react-router';
import { z } from 'zod';

/**
 * Which view is on screen, and how it is sorted and filtered - held in the URL.
 *
 * **The URL is this application's primary state container**, and a view is the clearest case for
 * it: "the board, grouped by status, filtered to this quarter, sorted by owner" is exactly the
 * thing somebody pastes into a message. Held in a store instead, every such link would point at
 * the folder's default view and the recipient would have to rebuild what they were sent.
 *
 * **The URL wins over the container's stored view, and that is deliberate.** A container stores
 * which views it offers and how each is configured; the URL says which of them is open and what
 * the person looking at it has done since. When the two disagree the URL is the more specific
 * statement - somebody chose it, just now, possibly in a link they were given - so the stored view
 * is the starting point rather than the authority.
 *
 * Sort and filter replace rather than push, so dragging a column header does not fill the back
 * button with history nobody wanted. Changing view pushes, because Back meaning "the board I was
 * just looking at" is what everybody expects.
 */

export const VIEW_PARAM = 'view';
export const SORT_PARAM = 'sort';
export const DIRECTION_PARAM = 'dir';
export const FILTER_PREFIX = 'f.';

export const SortDirectionSchema = z.enum(['ascending', 'descending']);

export type SortDirection = z.infer<typeof SortDirectionSchema>;

export const DEFAULT_SORT_DIRECTION: SortDirection = 'ascending';

/** One property filter: show only items whose property equals one of these values. */
export interface ViewFilter {
  readonly propertyKey: string;
  readonly values: readonly string[];
}

export interface ViewState {
  /** The view the URL names, or null to fall back to the container's first. */
  readonly viewId: string | null;

  /** The property key to sort by, or null for the view's own configured sort. */
  readonly sortBy: string | null;

  readonly direction: SortDirection;

  /** Every active property filter, in the order the URL happened to carry them. */
  readonly filters: readonly ViewFilter[];
}

export interface ViewStateControl extends ViewState {
  readonly selectView: (viewId: string) => void;
  readonly setSort: (propertyKey: string, direction: SortDirection) => void;
  readonly clearSort: () => void;
  readonly setFilter: (propertyKey: string, values: readonly string[]) => void;
  readonly clearFilters: () => void;
}

/**
 * Reads a direction out of the URL.
 *
 * Exported so it is testable without a router, and so an unrecognised value is handled in one
 * place rather than at every reader. A malformed direction falls back to ascending and says so:
 * an unparseable URL usually means a link we generated somewhere else has drifted, which is worth
 * knowing about rather than silently correcting.
 */
export function parseDirection(raw: string | null): SortDirection {
  if (raw === null) {
    return DEFAULT_SORT_DIRECTION;
  }

  const parsed = SortDirectionSchema.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }

  console.warn(`Ignoring unrecognised "${DIRECTION_PARAM}" search parameter:`, raw);
  return DEFAULT_SORT_DIRECTION;
}

/**
 * Reads every filter out of a query string.
 *
 * Filters are `f.<propertyKey>=<value>&f.<propertyKey>=<other>` rather than one packed parameter,
 * so a person can read a link and see what it filters to, and so adding a value is appending a
 * parameter rather than parsing and rewriting an encoding of our own.
 */
export function parseFilters(params: URLSearchParams): readonly ViewFilter[] {
  const byKey = new Map<string, string[]>();

  for (const [name, value] of params) {
    if (!name.startsWith(FILTER_PREFIX) || value.length === 0) {
      continue;
    }

    const key = name.slice(FILTER_PREFIX.length);
    if (key.length === 0) {
      continue;
    }

    const values = byKey.get(key) ?? [];
    values.push(value);
    byKey.set(key, values);
  }

  return [...byKey].map(([propertyKey, values]) => ({ propertyKey, values }));
}

/** Reads the whole view state out of a query string. Exported for testing without a router. */
export function parseViewState(params: URLSearchParams): ViewState {
  const viewId = params.get(VIEW_PARAM);
  const sortBy = params.get(SORT_PARAM);

  return {
    viewId: viewId !== null && viewId.length > 0 ? viewId : null,
    sortBy: sortBy !== null && sortBy.length > 0 ? sortBy : null,
    direction: parseDirection(params.get(DIRECTION_PARAM)),
    filters: parseFilters(params),
  };
}

export function useViewState(): ViewStateControl {
  const [searchParams, setSearchParams] = useSearchParams();
  const state = parseViewState(searchParams);

  const write = useCallback(
    (mutate: (next: URLSearchParams) => void, push: boolean): void => {
      const next = new URLSearchParams(searchParams);
      mutate(next);
      setSearchParams(next, { replace: !push });
    },
    [searchParams, setSearchParams],
  );

  const selectView = useCallback(
    (viewId: string): void => {
      write((next) => {
        next.set(VIEW_PARAM, viewId);

        // The sort and the filters belonged to the view being left. Carrying them across would
        // apply a board's grouping filter to a calendar, which is not what anybody meant by
        // switching view.
        next.delete(SORT_PARAM);
        next.delete(DIRECTION_PARAM);
        for (const name of [...next.keys()]) {
          if (name.startsWith(FILTER_PREFIX)) {
            next.delete(name);
          }
        }
      }, true);
    },
    [write],
  );

  const setSort = useCallback(
    (propertyKey: string, direction: SortDirection): void => {
      write((next) => {
        next.set(SORT_PARAM, propertyKey);
        next.set(DIRECTION_PARAM, direction);
      }, false);
    },
    [write],
  );

  const clearSort = useCallback((): void => {
    write((next) => {
      next.delete(SORT_PARAM);
      next.delete(DIRECTION_PARAM);
    }, false);
  }, [write]);

  const setFilter = useCallback(
    (propertyKey: string, values: readonly string[]): void => {
      write((next) => {
        next.delete(`${FILTER_PREFIX}${propertyKey}`);
        for (const value of values) {
          next.append(`${FILTER_PREFIX}${propertyKey}`, value);
        }
      }, false);
    },
    [write],
  );

  const clearFilters = useCallback((): void => {
    write((next) => {
      for (const name of [...next.keys()]) {
        if (name.startsWith(FILTER_PREFIX)) {
          next.delete(name);
        }
      }
    }, false);
  }, [write]);

  return { ...state, selectView, setSort, clearSort, setFilter, clearFilters };
}
