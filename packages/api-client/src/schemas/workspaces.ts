/**
 * A workspace: a container of items, one of the several a tenant may hold.
 *
 * The schema is the source of truth and the type is `z.infer` of it; the `satisfies` line ties it
 * to the generated contract so a backend rename fails this package's build rather than a user's
 * request. The two quota fields arrive as strings because they are 64-bit and 32-bit integers the
 * JSON contract widens to `["integer","string"]` to survive a language whose numbers are not - so
 * they are carried as strings and parsed where a number is actually needed, rather than lost to a
 * double here.
 */

import { z } from 'zod';
import type { components } from '../generated/api.js';

export const workspaceSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  versionRetentionDays: z.union([z.number(), z.string()]),
  storageQuotaBytes: z.union([z.number(), z.string()]),
  createdAt: z.iso.datetime({ offset: true }),
  kind: z.enum(['personal', 'shared']),
  canRename: z.boolean(),
  canManageMembers: z.boolean(),
  canLeave: z.boolean(),
});

export type Workspace = z.infer<typeof workspaceSchema>;

const _workspaceContract = workspaceSchema satisfies z.ZodType<
  components['schemas']['WorkspaceResponse']
>;
void _workspaceContract;

export const workspaceMemberSchema = z.object({
  subjectType: z.enum(['principal', 'group']),
  subjectId: z.uuid(),
  subjectDisplayName: z.string(),
  email: z.string().nullable(),
  role: z.enum(['owner', 'editor', 'commenter', 'viewer']),
  grantedAt: z.iso.datetime({ offset: true }),
  canChangeRole: z.boolean(),
  canRemove: z.boolean(),
  assignableRoles: z.array(z.string()),
});
export type WorkspaceMember = z.infer<typeof workspaceMemberSchema>;

const _workspaceMemberContract = workspaceMemberSchema satisfies z.ZodType<
  components['schemas']['WorkspaceMemberResponse']
>;
void _workspaceMemberContract;

export const workspaceInvitationSchema = z.object({
  id: z.uuid(),
  emailNormalized: z.string().min(1).max(320),
  role: z.enum(['owner', 'editor', 'commenter', 'viewer']),
  status: z.enum(['pending', 'accepted', 'revoked']),
  invitedByPrincipalId: z.uuid(),
  invitedAt: z.iso.datetime({ offset: true }),
  acceptedAt: z.iso.datetime({ offset: true }).nullable(),
  acceptedByPrincipalId: z.uuid().nullable(),
  revokedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type WorkspaceInvitation = z.infer<typeof workspaceInvitationSchema>;

const _workspaceInvitationContract = workspaceInvitationSchema satisfies z.ZodType<
  components['schemas']['WorkspaceInvitationResponse']
>;
void _workspaceInvitationContract;

export const dailyNoteSchema = z.object({ itemId: z.uuid() });
export type DailyNote = z.infer<typeof dailyNoteSchema>;

const _dailyNoteContract = dailyNoteSchema satisfies z.ZodType<
  components['schemas']['DailyNoteResponse']
>;
void _dailyNoteContract;
