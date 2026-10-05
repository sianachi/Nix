/**
 * The saved-query resource: the only place the query URL appears.
 *
 * One read, one descriptor, and deliberately no way to send rules. The stored view is the whole
 * query - a caller who could supply rules could project any property of every item it can read,
 * and probe ones it cannot - so this resource names the view and the caller's day, and nothing
 * else. Rules are edited through the ordinary views endpoint.
 *
 * `today` is required rather than defaulted: only the caller's own zone decides which day today
 * is, and a server guessing would move every relative rule for readers in other zones.
 */

import { defineQuery, type QueryEndpoint } from '../endpoints.js';
import { itemQueryResultsSchema, type ItemQueryResults } from '../schemas/index.js';

/**
 * Cache key for one run of one query view on one day.
 *
 * The day is part of the key because two days are two answers: an Overdue list read across
 * midnight must not serve yesterday's rows to today's request.
 */
const itemQueryKey = (itemId: string, viewId: string, today: string): readonly string[] => [
  'items',
  itemId,
  'query',
  viewId,
  today,
];

/**
 * Runs the saved query one of an item's views stores.
 *
 * Items the caller may not read are absent from the results and never spend the limit - the
 * filter runs inside the statement. An item or view that is not visible answers 404; a malformed
 * `today` answers `query.invalid_today` rather than an empty list, so a typo cannot read as
 * "nothing matches"; stored rules that no longer validate answer `query.invalid_rules` rather
 * than running wider than the saved query asked.
 *
 * @param itemId The smart list.
 * @param viewId Which of its views to run.
 * @param today The caller's own day, `yyyy-MM-dd`.
 */
export const itemQuery = (
  itemId: string,
  viewId: string,
  today: string,
): QueryEndpoint<ItemQueryResults> =>
  defineQuery<ItemQueryResults>({
    operation: 'itemQuery.get',
    path: `/api/v1/items/${itemId}/query?view=${encodeURIComponent(viewId)}&today=${encodeURIComponent(today)}`,
    schema: itemQueryResultsSchema,
    cacheKey: itemQueryKey(itemId, viewId, today),
  });
