/**
 * The search resource: the only place the search URL appears.
 *
 * One read. `limit` is optional — Core caps it either way — and the response carries `truncated`
 * explicitly so a caller can distinguish a complete result from a capped one.
 */

import { defineQuery, type QueryEndpoint } from '../endpoints.js';
import { searchResultsSchema, type SearchResults } from '../schemas/index.js';

/** Full-text search across the items the caller can see. */
export const searchItems = (query: string, limit?: number): QueryEndpoint<SearchResults> =>
  defineQuery<SearchResults>({
    operation: 'search.run',
    path: '/api/v1/search',
    schema: searchResultsSchema,
    query: { q: query, limit },
    // Search reflects the last flushed index snapshot, so it is not a cache identity worth reusing;
    // every call re-runs.
    cacheKey: undefined,
  });
