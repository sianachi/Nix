/** Reference lookup resources: the only place reference and backlink URLs appear. */

import { defineQuery, type QueryEndpoint } from '../endpoints.js';
import {
  backlinksSchema,
  referencesSchema,
  type Backlinks,
  type References,
} from '../schemas/index.js';

/** Resolves a batch of document reference targets in request order. */
export const resolveReferences = (ids: readonly string[]): QueryEndpoint<References> =>
  defineQuery<References>({
    operation: 'references.resolve',
    path: '/api/v1/search/references',
    query: { ids: ids.join(',') },
    schema: referencesSchema,
    cacheKey: ['references', ...ids],
  });

/** Lists readable documents that refer to an item. */
export const listBacklinks = (itemId: string, limit?: number): QueryEndpoint<Backlinks> =>
  defineQuery<Backlinks>({
    operation: 'backlinks.list',
    path: `/api/v1/items/${itemId}/backlinks`,
    query: { limit },
    schema: backlinksSchema,
    cacheKey: ['items', itemId, 'backlinks', ...(limit === undefined ? [] : [String(limit)])],
  });
