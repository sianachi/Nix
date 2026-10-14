import { isCanceledError, search, type SearchResults } from '@nix/api-client';
import { FileText } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ListboxOption } from '@nix/ui';

import { useApiClient } from '../api/api-client-provider';
import { CANDIDATE_POOL, DEBOUNCE_MS, MINIMUM_QUERY, RESULT_LIMIT } from './reference-menu';

type Hit = SearchResults['results'][number];

/** What the `[[` picker in Markdown mode shows for a query: the rich editor's search, unranked. */
export function useNoteLinkSearch(query: string | null): {
  readonly hits: readonly Hit[];
  readonly options: readonly ListboxOption[];
  readonly emptyMessage: string;
} {
  const client = useApiClient();
  // Keyed by the query it answers, so a stale answer is never shown for the next query.
  const [answer, setAnswer] = useState<{
    readonly query: string;
    readonly hits: readonly Hit[];
    readonly failed: boolean;
  } | null>(null);

  useEffect(() => {
    if (query === null || query.length < MINIMUM_QUERY) {
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await client.query(search.searchItems(query, CANDIDATE_POOL), {
            signal: controller.signal,
          });
          if (!controller.signal.aborted) {
            setAnswer({ query, hits: response.results.slice(0, RESULT_LIMIT), failed: false });
          }
        } catch (cause) {
          if (controller.signal.aborted || isCanceledError(cause)) {
            return;
          }
          console.warn('The reference search failed.', cause);
          setAnswer({ query, hits: [], failed: true });
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, query]);

  const current = answer !== null && answer.query === query ? answer : null;
  const hits = current?.hits ?? [];
  return {
    hits,
    options: hits.map((hit) => ({ id: hit.id, label: hit.title ?? 'Untitled', icon: FileText })),
    emptyMessage: current?.failed
      ? 'Could not search just now. Check your connection and try again.'
      : (query ?? '').length < MINIMUM_QUERY
        ? `Type ${String(MINIMUM_QUERY)} letters or more to find an item.`
        : current === null
          ? 'Searching…'
          : 'No item matches that.',
  };
}
