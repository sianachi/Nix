/**
 * The My Day resource: the only place its URL appears.
 *
 * One read, no parameters beyond the workspace. The caller's identity and day are resolved by Core,
 * never sent, so a client cannot ask for someone else's day or for a day that suits it.
 */

import { defineQuery, type QueryEndpoint } from '../endpoints.js';
import { myDaySchema, type MyDay } from '../schemas/index.js';

/**
 * What the caller should do today in one workspace.
 *
 * Re-read after finishing a task or checking in a habit: a write does not invalidate this key,
 * because the rows are projections of items this resource does not own.
 *
 * @param workspaceId The workspace to read. One the caller may not see answers `workspaces.not_found`.
 */
export const myDay = (workspaceId: string): QueryEndpoint<MyDay> =>
  defineQuery<MyDay>({
    operation: 'myDay.get',
    path: `/api/v1/workspaces/${workspaceId}/my-day`,
    schema: myDaySchema,
    cacheKey: ['workspaces', workspaceId, 'my-day'],
  });
