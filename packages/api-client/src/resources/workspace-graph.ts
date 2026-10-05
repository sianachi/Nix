/**
 * The workspace graph resource: the only place the graph URL appears.
 *
 * One read, one descriptor. There is deliberately no limit option — the ceilings belong to the
 * server, are reported back in the payload, and a caller who could raise them could serve
 * themselves a response nobody can draw. What a caller does get is the truth about whether the
 * graph is complete, in `nodesTruncated` and `linksTruncated`.
 */

import { defineQuery, type QueryEndpoint } from '../endpoints.js';
import { workspaceGraphSchema, type WorkspaceGraph } from '../schemas/index.js';

/** Cache key for one workspace's graph. */
const workspaceGraphKey = (workspaceId: string): readonly string[] => [
  'workspaces',
  workspaceId,
  'graph',
];

/**
 * Everything needed to draw one workspace: its readable items and the reference edges between
 * them.
 *
 * Items the caller may not read are absent from the nodes, from every link, and from the counts —
 * the filter is applied while the query runs, not to its results. A workspace the caller may not
 * see answers `workspaces.not_found`, the same code `GET /api/v1/workspaces/{id}` uses.
 */
export const workspaceGraph = (workspaceId: string): QueryEndpoint<WorkspaceGraph> =>
  defineQuery<WorkspaceGraph>({
    operation: 'workspaceGraph.get',
    path: `/api/v1/workspaces/${workspaceId}/graph`,
    schema: workspaceGraphSchema,
    cacheKey: workspaceGraphKey(workspaceId),
  });
