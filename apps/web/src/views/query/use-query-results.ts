import { itemQueryResultsSchema, type ItemQueryResults } from '@nix/api-client';
import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '../../auth/auth-provider';
import { readerZone } from '../core/timestamps';

/**
 * One run of a saved query, refreshed on demand.
 *
 * Talks to Core with `fetch` rather than through `@nix/api-client`'s cache layer, for the reason
 * `use-workspace-calendar.ts` gives: the descriptor executor wants a configured `NixClient` and
 * this needs one thing, a bearer token per request. The schema is the package's own
 * (`itemQueryResultsSchema`), so the parse is not duplicated logic - only the transport is, and
 * both change together when the client is wired.
 *
 * **The client never sends rules.** It names the item, the view and its own day; the stored view
 * is the whole query. `today` is computed in the reader's zone on every load, because only the
 * reader's zone decides which day it is - an Overdue list read across midnight refetches as the
 * new day the moment it reloads.
 */

/** Today as the reader's own calendar day, `yyyy-MM-dd`. */
export function readerToday(): string {
  // en-CA formats as YYYY-MM-DD, which is the one locale trick this file allows itself: the
  // alternative is hand-assembling parts, and both are pinned by the test asserting the shape.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: readerZone(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * Why a failed run failed, in words a reader can act on - keyed on the problem's `code`, not the
 * status alone, for the reason `use-workspace-graph.ts` records: a bodyless 404 is this build
 * asking a server that does not offer the endpoint, not a refusal.
 */
async function refusal(response: Response): Promise<string> {
  const code: unknown = await response
    .json()
    .then((body: unknown) =>
      typeof body === 'object' && body !== null && 'code' in body ? body.code : null,
    )
    .catch(() => null);

  if (code === 'items.not_found') {
    return 'This smart list could not be found.';
  }

  if (code === 'query.view_not_found') {
    return 'This item has no query view to run. Configure one under Views.';
  }

  if (code === 'query.invalid_rules') {
    return 'A stored filter no longer validates, so the query was not run. Edit the filters and save them again.';
  }

  if (code === 'query.invalid_today') {
    // Not a reader's mistake - the day is computed, not typed. On screen, this is a bug.
    return 'This version of the application sent a day the server refused.';
  }

  if (response.status === 404) {
    return 'This version of the application asked for a query the server does not offer. The server may be running an older build.';
  }

  return 'The smart list could not be loaded.';
}

export type QueryResultsStatus = 'loading' | 'ready' | 'error';

export interface QueryResultsState {
  readonly status: QueryResultsStatus;

  /** The payload, or null while loading and after a failure. Never a half-built stand-in. */
  readonly results: ItemQueryResults | null;
  readonly error: string | null;
  readonly reload: () => Promise<void>;
}

export function useQueryResults(itemId: string, viewId: string): QueryResultsState {
  const { getAccessToken } = useAuth();

  const [status, setStatus] = useState<QueryResultsStatus>('loading');
  const [results, setResults] = useState<ItemQueryResults | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setStatus('loading');
    setError(null);

    try {
      const token = await getAccessToken();
      const today = readerToday();
      const response = await fetch(
        `/api/v1/items/${itemId}/query?view=${encodeURIComponent(viewId)}&today=${encodeURIComponent(today)}`,
        {
          headers: {
            'content-type': 'application/json',
            ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          },
        },
      );

      if (!response.ok) {
        setError(await refusal(response));
        setStatus('error');
        return;
      }

      const parsed = itemQueryResultsSchema.safeParse(await response.json());
      if (!parsed.success) {
        // A parse failure is telemetry, not a silent fallback: the contract moved and this build
        // did not.
        console.warn('A query response did not match the contract:', parsed.error.message);
        setError('The smart list could not be read.');
        setStatus('error');
        return;
      }

      setResults(parsed.data);
      setStatus('ready');
    } catch {
      setError('Core could not be reached.');
      setStatus('error');
    }
  }, [getAccessToken, itemId, viewId]);

  useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  return { status, results, error, reload: load };
}
