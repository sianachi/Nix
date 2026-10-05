import {
  isCanceledError,
  isNixApiError,
  itemChart as coreItemChart,
  type ItemChart,
} from '@nix/api-client';
import { useCallback, useEffect, useState } from 'react';

import { useApiClient } from '../../api/api-client-provider';

/**
 * One chart view's buckets, refreshed on demand.
 *
 * Uses the configured API client so authentication, cancellation, caching, error mapping, and
 * response parsing stay on the same path as the other server-owned views.
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
function refusal(reason: unknown): string {
  const code = isNixApiError(reason) ? reason.code : null;

  if (code === 'items.not_found') {
    return 'This item could not be found.';
  }

  if (code === 'chart.view_not_found') {
    return 'This item has no chart view to draw. Configure one under Views.';
  }

  if (code === 'chart.not_configured') {
    return 'This chart is not finished: it needs a property to group by, and a property to total if it totals one. Edit it under Views.';
  }

  if (isNixApiError(reason) && reason.status === 404) {
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
  const client = useApiClient();

  const [status, setStatus] = useState<ChartStatus>('loading');
  const [chart, setChart] = useState<ItemChart | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setStatus('loading');
    setError(null);

    try {
      const loaded = await client.query(coreItemChart.itemChart(itemId, viewId));
      setChart(loaded);
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

  return { status, chart, error, reload: load };
}
