import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import type { components } from '../generated/api.js';
import {
  workspaceArrangementResponseSchema,
  type WorkspaceArrangementInput,
  type WorkspaceArrangementResponse,
} from '../schemas/workspace-arrangement.js';

const arrangementKey = ['me', 'workspace-arrangement'] as const;

/** The caller's own groups and pins; empty at revision 0 when never saved. */
export const arrangement = (): QueryEndpoint<WorkspaceArrangementResponse> =>
  defineQuery({
    operation: 'workspaceArrangement.get',
    path: '/api/v1/me/workspace-arrangement',
    schema: workspaceArrangementResponseSchema,
    cacheKey: arrangementKey,
  });

export const saveArrangement = (
  expectedRevision: number,
  value: WorkspaceArrangementInput,
): CommandEndpoint<WorkspaceArrangementResponse> =>
  defineCommand({
    operation: 'workspaceArrangement.save',
    method: 'PUT',
    path: '/api/v1/me/workspace-arrangement',
    schema: workspaceArrangementResponseSchema,
    body: {
      expectedRevision,
      arrangement: {
        pinnedWorkspaceIds: value.pinnedWorkspaceIds,
        groups: value.groups.map(
          ({
            conversationItemIds,
            lastDestinationWorkspaceId,
            lastDestinationParentId,
            ...group
          }) => ({
            ...group,
            ...(conversationItemIds === undefined ? {} : { conversationItemIds }),
            ...(lastDestinationWorkspaceId === undefined ? {} : { lastDestinationWorkspaceId }),
            ...(lastDestinationParentId === undefined ? {} : { lastDestinationParentId }),
          }),
        ),
      },
    } satisfies components['schemas']['SaveWorkspaceArrangementRequest'],
    invalidates: [arrangementKey],
  });
