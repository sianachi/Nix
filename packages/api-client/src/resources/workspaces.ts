/**
 * The workspaces resource: the only place workspace URLs appear.
 *
 * A workspace list is how a caller finds the ids every item command needs, so it is the first thing
 * a scripted session reads. Cursor-paginated like every collection here, and consumed through the
 * client's `paginate`, so a caller never sees a cursor.
 */

import {
  defineCommand,
  definePagedQuery,
  defineQuery,
  type CommandEndpoint,
  type PagedQueryEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import {
  dailyNoteSchema,
  noContentSchema,
  workspaceInvitationSchema,
  workspaceMemberSchema,
  workspaceSchema,
  type DailyNote,
  type Workspace,
  type WorkspaceInvitation,
  type WorkspaceMember,
} from '../schemas/index.js';
import { cursorPageSchema, type CursorPage } from '../schemas/pagination.js';
import type { components } from '../generated/api.js';

export type AssignableWorkspaceRole =
  components['schemas']['ChangeWorkspaceMemberRoleRequest']['role'];

export interface WorkspacePageOptions {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** Every workspace the caller can reach, in the order Core returns them. */
export const listWorkspaces = (): PagedQueryEndpoint<Workspace> =>
  definePagedQuery<Workspace>({
    operation: 'workspaces.list',
    path: '/api/v1/workspaces',
    itemSchema: workspaceSchema,
  });

export const listWorkspacesPage = (
  options: WorkspacePageOptions = {},
): QueryEndpoint<CursorPage<Workspace>> =>
  defineQuery({
    operation: 'workspaces.list.page',
    path: '/api/v1/workspaces',
    query: { cursor: options.cursor, limit: options.limit },
    schema: cursorPageSchema(workspaceSchema),
  });

/** One workspace by id. */
export const workspaceById = (workspaceId: string): QueryEndpoint<Workspace> =>
  defineQuery<Workspace>({
    operation: 'workspaces.get',
    path: `/api/v1/workspaces/${workspaceId}`,
    schema: workspaceSchema,
    cacheKey: ['workspaces', workspaceId],
  });

const workspaceListKey = ['workspaces'] as const;
export const createWorkspace = (name: string): CommandEndpoint<Workspace> =>
  defineCommand({
    operation: 'workspaces.create',
    method: 'POST',
    path: '/api/v1/workspaces',
    body: { name },
    schema: workspaceSchema,
    invalidates: [workspaceListKey],
  });
export const renameWorkspace = (workspaceId: string, name: string): CommandEndpoint<Workspace> =>
  defineCommand({
    operation: 'workspaces.rename',
    method: 'PATCH',
    path: `/api/v1/workspaces/${workspaceId}`,
    body: { name },
    schema: workspaceSchema,
    invalidates: [workspaceListKey, ['workspaces', workspaceId]],
  });
export const listMembers = (workspaceId: string): PagedQueryEndpoint<WorkspaceMember> =>
  definePagedQuery({
    operation: 'workspaces.members.list',
    path: `/api/v1/workspaces/${workspaceId}/members`,
    itemSchema: workspaceMemberSchema,
  });
export const listMembersPage = (
  workspaceId: string,
  options: WorkspacePageOptions = {},
): QueryEndpoint<CursorPage<WorkspaceMember>> =>
  defineQuery({
    operation: 'workspaces.members.list.page',
    path: `/api/v1/workspaces/${workspaceId}/members`,
    query: { cursor: options.cursor, limit: options.limit },
    schema: cursorPageSchema(workspaceMemberSchema),
  });
export const changeMemberRole = (
  workspaceId: string,
  principalId: string,
  role: AssignableWorkspaceRole,
): CommandEndpoint<WorkspaceMember> =>
  defineCommand({
    operation: 'workspaces.members.change',
    method: 'PATCH',
    path: `/api/v1/workspaces/${workspaceId}/members/${principalId}`,
    body: { role },
    schema: workspaceMemberSchema,
    invalidates: [['workspaces', workspaceId, 'members']],
  });
export const removeMember = (
  workspaceId: string,
  principalId: string,
): CommandEndpoint<undefined> =>
  defineCommand({
    operation: 'workspaces.members.remove',
    method: 'DELETE',
    path: `/api/v1/workspaces/${workspaceId}/members/${principalId}`,
    schema: noContentSchema,
    invalidates: [['workspaces', workspaceId, 'members']],
  });
export const leaveWorkspace = (workspaceId: string): CommandEndpoint<undefined> =>
  defineCommand({
    operation: 'workspaces.leave',
    method: 'POST',
    path: `/api/v1/workspaces/${workspaceId}/leave`,
    schema: noContentSchema,
    invalidates: [workspaceListKey],
  });
export const recoverWorkspace = (
  workspaceId: string,
  newOwnerPrincipalId: string,
): CommandEndpoint<Workspace> =>
  defineCommand({
    operation: 'workspaces.recover',
    method: 'POST',
    path: `/api/v1/workspaces/${workspaceId}/recover`,
    body: { newOwnerPrincipalId },
    schema: workspaceSchema,
    invalidates: [workspaceListKey, ['workspaces', workspaceId]],
  });
export const listInvitations = (workspaceId: string): PagedQueryEndpoint<WorkspaceInvitation> =>
  definePagedQuery({
    operation: 'workspaces.invitations.list',
    path: `/api/v1/workspaces/${workspaceId}/invitations`,
    itemSchema: workspaceInvitationSchema,
  });
export const listInvitationsPage = (
  workspaceId: string,
  options: WorkspacePageOptions = {},
): QueryEndpoint<CursorPage<WorkspaceInvitation>> =>
  defineQuery({
    operation: 'workspaces.invitations.list.page',
    path: `/api/v1/workspaces/${workspaceId}/invitations`,
    query: { cursor: options.cursor, limit: options.limit },
    schema: cursorPageSchema(workspaceInvitationSchema),
  });
export const createInvitation = (
  workspaceId: string,
  email: string,
  role: AssignableWorkspaceRole,
): CommandEndpoint<WorkspaceInvitation> =>
  defineCommand({
    operation: 'workspaces.invitations.create',
    method: 'POST',
    path: `/api/v1/workspaces/${workspaceId}/invitations`,
    body: { email, role },
    schema: workspaceInvitationSchema,
    invalidates: [
      ['workspaces', workspaceId, 'invitations'],
      ['workspaces', workspaceId, 'members'],
    ],
  });
export const revokeInvitation = (
  workspaceId: string,
  invitationId: string,
): CommandEndpoint<undefined> =>
  defineCommand({
    operation: 'workspaces.invitations.revoke',
    method: 'DELETE',
    path: `/api/v1/workspaces/${workspaceId}/invitations/${invitationId}`,
    schema: noContentSchema,
    invalidates: [['workspaces', workspaceId, 'invitations']],
  });
export const openDailyNote = (workspaceId: string, date: string): CommandEndpoint<DailyNote> =>
  defineCommand({
    operation: 'workspaces.daily.open',
    method: 'PUT',
    path: `/api/v1/workspaces/${workspaceId}/daily-notes/${date}`,
    schema: dailyNoteSchema,
  });
