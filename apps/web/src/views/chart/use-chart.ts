import { itemChartSchema, type ItemChart } from '@nix/api-client';
import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '../../auth/auth-provider';

/**
 * One chart view's buckets, refreshed on demand.
 *
 * Talks to Core with `fetch` rather than through `@nix/api-client`'s cache layer, for the reason
 * `use-query-results.ts` gives: the descriptor executor wants a configured `NixClient` and this
 * needs one thing, a bearer token per request. The schema is the package's own, so the parse is
 * not duplicated logic - only the transport is, and both change together when the client is wired.
 *
 * **The client names the view and never sends the grouping.** The stored view is the whole
 * configuration, exactly as it is for a smart list, and the buckets are computed over every child
 * rather than over the page the container happens to have loaded - which is what a chart tallied in
 * the browser could not honestly claim.
 */

/**
 * Why a failed read failed, in words a reader can act on.
 *
 * Keyed on the problem's `code` rather than on the status alone: a bodyless 404 is this build
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
    return 'This item could not be found.';
  }

  if (code === 'chart.view_not_found') {
    return 'This item has no chart view to draw. Configure one under Views.';
  }

  if (code === 'chart.not_configured') {
    return 'This chart is not finished: it needs a property to group by, and a property to total if it totals one. Edit it under Views.';
  }

  if (response.status === 404) {
    return 'This version of the application asked for a chart the server does not offer. The server may be running an older build.';
  }

  return 'The chart could not be loaded.';
}

export type ChartStatus = 'loading' | 'ready' | 'error';

export interface ChartState {
  readonly status: ChartStatus;

  /** The payload, or null while loading and after a failure. Never a half-built stand-in. */
  readonly chart: ItemChart | null;
  readonly error: string | null;
  readonly reload: () => Promise<void>;
}

export function useChart(itemId: string, viewId: string): ChartState {
  const { getAccessToken } = useAuth();

  const [status, setStatus] = useState<ChartStatus>('loading');
  const [chart, setChart] = useState<ItemChart | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setStatus('loading');
    setError(null);

    try {
      const token = await getAccessToken();
      const response = await fetch(
        `/api/v1/items/${itemId}/chart?view=${encodeURIComponent(viewId)}`,
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

      const parsed = itemChartSchema.safeParse(await response.json());
      if (!parsed.success) {
        // A parse failure is telemetry, not a silent fallback: the contract moved and this build
        // did not.
        console.warn('A chart response did not match the contract:', parsed.error.message);
        setError('The chart could not be read.');
        setStatus('error');
        return;
      }

      setChart(parsed.data);
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

  return { status, chart, error, reload: load };
}
