/**
 * The workspaces resource: the only place workspace URLs appear.
 *
 * A workspace list is how a caller finds the ids every item command needs, so it is the first thing
 * a scripted session reads. Cursor-paginated like every collection here, and consumed through the
 * client's `paginate`, so a caller never sees a cursor.
 */

import { definePagedQuery, defineQuery, type PagedQueryEndpoint, type QueryEndpoint } from '../endpoints.js';
import { workspaceSchema, type Workspace } from '../schemas/index.js';

/** Every workspace the caller can reach, in the order Core returns them. */
export const listWorkspaces = (): PagedQueryEndpoint<Workspace> =>
  definePagedQuery<Workspace>({
    operation: 'workspaces.list',
    path: '/api/v1/workspaces',
    itemSchema: workspaceSchema,
  });

/** One workspace by id. */
export const workspaceById = (workspaceId: string): QueryEndpoint<Workspace> =>
  defineQuery<Workspace>({
    operation: 'workspaces.get',
    path: `/api/v1/workspaces/${workspaceId}`,
    schema: workspaceSchema,
    cacheKey: ['workspaces', workspaceId],
  });
