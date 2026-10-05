/**
 * `nixctl search`: full-text search across the items the caller can see.
 *
 * The result carries `truncated` as its own field, printed as such: a capped result set is an honest
 * partial answer, and a script must be able to see "there are more" rather than treat a limited list
 * as the whole. This is the read a `search-storm` stress scenario drives.
 */

import { search } from '@nix/api-client';
import { resolveSession, type SessionDeps } from './shared.ts';
import { printResult, type OutputOptions } from '../output.ts';

export interface SearchOptions {
  /** Cap the number of hits; Core applies its own ceiling regardless. */
  readonly limit?: number | undefined;
}

/** Runs a full-text search and prints the hits, the count, and whether the result was truncated. */
export async function runSearch(
  profileName: string | undefined,
  query: string,
  options: SearchOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  const answer = await session.client.query(search.searchItems(query, options.limit));

  printResult(
    {
      query: answer.query,
      results: answer.results,
      count: answer.results.length,
      limit: answer.limit,
      truncated: answer.truncated,
    },
    output,
  );
}
