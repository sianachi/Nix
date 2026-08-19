/**
 * Full-text search results, as `GET /api/v1/search` returns them.
 *
 * `truncated` is carried as its own field, never folded into the result list: a cut result set is an
 * honest partial answer, and a caller (the CLI, the MCP server) must be able to say "there are more"
 * rather than present a capped list as complete. Each hit is the identity a caller needs to open the
 * item — its id, its workspace, its body kind and its title — and nothing heavier.
 */

import { z } from 'zod';
import type { components } from '../generated/api.js';

export const searchHitSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  type: z.string(),
  title: z.string().nullable(),
});

export type SearchHit = z.infer<typeof searchHitSchema>;

export const searchResultsSchema = z.object({
  query: z.string(),
  results: z.array(searchHitSchema),
  /** The cap that was applied; the result count reaching it is why `truncated` may be set. */
  limit: z.number(),
  /** Whether more matches existed than the limit returned — an honest partial, never hidden. */
  truncated: z.boolean(),
});

export type SearchResults = z.infer<typeof searchResultsSchema>;

const _hitContract = searchHitSchema satisfies z.ZodType<components['schemas']['SearchHitResponse']>;
void _hitContract;

const _resultsContract = searchResultsSchema satisfies z.ZodType<
  components['schemas']['SearchResponse']
>;
void _resultsContract;
