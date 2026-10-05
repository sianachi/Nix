/**
 * `nixctl query`: the children one of a container's views shows.
 *
 * A view is a way of looking at children - a board's cards, a smart list's matches, what a calendar
 * or timeline places in a window - and this runs the saved query behind one and returns the rows.
 * It is how an agent or a script reads "what is on this board" or "what is due" without a browser,
 * and it is the read a stress run leans on to walk a container of thousands at the scale a person
 * never would.
 *
 * `today` is required and is the caller's own day: a relative rule ("within the next 7 days") means
 * nothing without the day it counts from, and letting the server guess would move the answer for
 * readers in other zones. `truncated` is surfaced as its own field, because a list that was cut and
 * does not say so reads as a list that ended.
 */

import { itemQuery as queries } from '@nix/api-client';
import { resolveSession, type SessionDeps } from './shared.ts';
import { printResult, type OutputOptions } from '../output.ts';

export interface QueryOptions {
  readonly view: string;
  readonly today: string;
}

/** Runs a container view's saved query and prints its rows, with the honest truncation flag. */
export async function runQuery(
  profileName: string | undefined,
  itemId: string,
  options: QueryOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  const answer = await session.client.query(queries.itemQuery(itemId, options.view, options.today));

  printResult(
    {
      results: answer.results.map((row) => ({
        id: row.id,
        title: row.title,
        type: row.type,
        containerId: row.containerId,
        containerTitle: row.containerTitle,
        properties: row.properties,
      })),
      count: answer.results.length,
      limit: answer.limit,
      truncated: answer.truncated,
    },
    output,
  );
}
