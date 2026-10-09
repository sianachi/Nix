/**
 * The ad-hoc workspace query resource: the only place the query and aggregate URLs appear.
 *
 * Both are reads sent as POSTs because rules do not fit a URL - they change nothing, so they
 * invalidate nothing, a read-scoped token may call them, and they share their own per-address
 * rate limit (`queries`), separate from writes; wait out a 429's `Retry-After`.
 *
 * The rules are the grammar a query view stores (`ViewFilterRule`): ANDed, with one level of
 * `{ any: [...] }` groups, at most eight conditions with the preset's. Items the caller may not
 * read are excluded while the query runs, so they never appear and never count in an aggregate.
 * A workspace the caller cannot read answers `workspaces.not_found`; a scope container it cannot
 * read answers `items.not_found`, exactly as reading that item would, and a locked one
 * `items.locked`. A rule set the grammar refuses answers `query.invalid_request`, and a missing or
 * malformed `today` when a rule needs it `query.invalid_today` - never an empty list.
 */

import { defineCommand, type CommandEndpoint } from '../endpoints.js';
import {
  workspaceAggregateSchema,
  workspaceQueryResultsSchema,
  type WorkspaceAggregate,
  type WorkspaceQueryResults,
} from '../schemas/index.js';
import type { components } from '../generated/api.js';

/** One condition, or an "any of" group of conditions - the generated wire shape. */
export type QueryFilterRule = components['schemas']['FilterRuleContract'];

/** The shipped smart lists a query may start from. */
export type QueryPreset = 'today' | 'next-seven-days' | 'overdue' | 'assigned-to-me';

/** The folds an aggregate may ask for. */
export type QueryAggregateFunction = 'count' | 'sum' | 'avg' | 'min' | 'max';

/** What both forms match. */
export interface WorkspaceQueryMatch {
  /** A container to look beneath; its whole subtree unless `descendants` is false. */
  readonly scope?: { readonly parentId: string; readonly descendants?: boolean };
  readonly preset?: QueryPreset;
  readonly filters?: readonly QueryFilterRule[];
  /** A property key, or `$type`; rows arrive group by group, `order` first. */
  readonly groupBy?: { readonly property: string; readonly order?: readonly string[] };
  /** The caller's own day, `yyyy-MM-dd`. Required when a rule uses a day token or a window. */
  readonly today?: string;
}

/** An ad-hoc query. */
export interface WorkspaceQuery extends WorkspaceQueryMatch {
  /** A property key, `$created`, `$modified` or `$type`. */
  readonly sort?: { readonly property: string; readonly descending?: boolean };
  /** 100 when absent, never more than 500. */
  readonly limit?: number;
}

/** An ad-hoc aggregate. */
export interface WorkspaceAggregateQuery extends WorkspaceQueryMatch {
  readonly aggregate: { readonly function: QueryAggregateFunction; readonly property?: string };
}

function matchBody(query: WorkspaceQueryMatch) {
  return {
    scope:
      query.scope === undefined
        ? null
        : { parentId: query.scope.parentId, descendants: query.scope.descendants ?? null },
    preset: query.preset ?? null,
    filters: query.filters === undefined ? null : [...query.filters],
    groupBy:
      query.groupBy === undefined
        ? null
        : {
            property: query.groupBy.property,
            order: query.groupBy.order === undefined ? null : [...query.groupBy.order],
          },
    today: query.today ?? null,
  };
}

/**
 * Runs an ad-hoc query over one workspace and returns its rows, grouped when asked.
 *
 * @param workspaceId The workspace to query.
 * @param query What to match, order, group and how many rows to return.
 */
export const runWorkspaceQuery = (
  workspaceId: string,
  query: WorkspaceQuery,
): CommandEndpoint<WorkspaceQueryResults> => {
  const body: components['schemas']['WorkspaceQueryRequest'] = {
    ...matchBody(query),
    sort:
      query.sort === undefined
        ? null
        : { property: query.sort.property, descending: query.sort.descending ?? null },
    limit: query.limit ?? null,
  };

  return defineCommand<WorkspaceQueryResults>({
    operation: 'workspaceQuery.run',
    method: 'POST',
    path: `/api/v1/workspaces/${workspaceId}/query`,
    body,
    schema: workspaceQueryResultsSchema,
    invalidates: [],
  });
};

/**
 * Folds an ad-hoc query over one workspace: a count, or the sum, mean, least or greatest of a
 * numeric property, in total and per group. Values that are not numbers are counted in `skipped`.
 *
 * @param workspaceId The workspace to query.
 * @param query What to match and group, and the fold.
 */
export const aggregateWorkspaceQuery = (
  workspaceId: string,
  query: WorkspaceAggregateQuery,
): CommandEndpoint<WorkspaceAggregate> => {
  const body: components['schemas']['WorkspaceAggregateRequest'] = {
    ...matchBody(query),
    aggregate: { function: query.aggregate.function, property: query.aggregate.property ?? null },
  };

  return defineCommand<WorkspaceAggregate>({
    operation: 'workspaceQuery.aggregate',
    method: 'POST',
    path: `/api/v1/workspaces/${workspaceId}/query/aggregate`,
    body,
    schema: workspaceAggregateSchema,
    invalidates: [],
  });
};
