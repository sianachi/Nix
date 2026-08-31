import {
  isCanceledError,
  isNixApiError,
  itemQuery as coreItemQuery,
  type ItemQueryResults,
} from '@nix/api-client';
import { useCallback, useEffect, useState } from 'react';

import { useApiClient } from '../../api/api-client-provider';
import { readerZone } from '../core/timestamps';

/**
 * One run of a saved query, refreshed on demand.
 *
 * Uses the configured `NixClient`, so the saved-query read shares the application's authentication,
 * cancellation, error mapping and response parsing path.
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
function refusal(reason: unknown): string {
  const code = isNixApiError(reason) ? reason.code : null;

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

  if (isNixApiError(reason) && reason.status === 404) {
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
  const client = useApiClient();

  const [status, setStatus] = useState<QueryResultsStatus>('loading');
  const [results, setResults] = useState<ItemQueryResults | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setStatus('loading');
    setError(null);

    try {
      const today = readerToday();
      const loaded = await client.query(coreItemQuery.itemQuery(itemId, viewId, today));
      setResults(loaded);
      setStatus('ready');
    } catch (reason) {
      if (isCanceledError(reason)) return;
      setError(isNixApiError(reason) ? refusal(reason) : 'Core could not be reached.');
      setStatus('error');
    }
  }, [client, itemId, viewId]);

  useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  return { status, results, error, reload: load };
}
