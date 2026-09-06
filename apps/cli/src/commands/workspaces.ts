/**
 * `nixctl ws`: the workspaces a token can reach.
 *
 * The list is the first thing a scripted session reads, because every item command needs a
 * workspace id and this is where they come from. List commands return one bounded cursor page so
 * automation cannot accidentally materialize an unbounded tenant history.
 */

import { workspaces, type AssignableWorkspaceRole } from '@nix/api-client';
import { resolveSession, type SessionDeps } from './shared.ts';
import { printResult, type OutputOptions } from '../output.ts';

/** Lists one bounded page of workspaces the profile can reach. */
export async function listWorkspaces(
  profileName: string | undefined,
  page: WorkspacePageOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  const result = await session.client.query(workspaces.listWorkspacesPage(validatePage(page)));
  printResult(
    { workspaces: result.items, count: result.items.length, nextCursor: result.nextCursor },
    output,
  );
}

export async function createWorkspace(
  profileName: string | undefined,
  name: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.execute(workspaces.createWorkspace(name)), output);
}

export async function renameWorkspace(
  profileName: string | undefined,
  workspaceId: string,
  name: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.execute(workspaces.renameWorkspace(workspaceId, name)), output);
}

/** Removes a workspace from everyday navigation without deleting its durable data. */
export async function archiveWorkspace(
  profileName: string | undefined,
  workspaceId: string,
  confirmed: boolean,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  assertConfirmed(confirmed);
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.execute(workspaces.archiveWorkspace(workspaceId)), output);
}

/** Returns an archived workspace to ordinary use. */
export async function restoreWorkspace(
  profileName: string | undefined,
  workspaceId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.execute(workspaces.restoreWorkspace(workspaceId)), output);
}

/** Schedules irreversible deletion of a workspace that has already been archived. */
export async function purgeWorkspace(
  profileName: string | undefined,
  workspaceId: string,
  confirmed: boolean,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  assertConfirmed(confirmed);
  const session = await resolveSession(profileName, deps);
  await session.client.execute(workspaces.purgeWorkspace(workspaceId));
  printResult({ purging: true, workspaceId }, output);
}

export async function listWorkspaceInvitations(
  profileName: string | undefined,
  workspaceId: string,
  page: WorkspacePageOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  const result = await session.client.query(
    workspaces.listInvitationsPage(workspaceId, validatePage(page)),
  );
  printResult(
    { invitations: result.items, count: result.items.length, nextCursor: result.nextCursor },
    output,
  );
}

export async function listWorkspaceInvitees(
  profileName: string | undefined,
  workspaceId: string,
  page: WorkspacePageOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  const result = await session.client.query(
    workspaces.listInviteesPage(workspaceId, validatePage(page)),
  );
  printResult(
    { invitees: result.items, count: result.items.length, nextCursor: result.nextCursor },
    output,
  );
}

export async function inviteWorkspaceMember(
  profileName: string | undefined,
  workspaceId: string,
  principalId: string,
  role: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  assertUiRole(role);
  const session = await resolveSession(profileName, deps);
  printResult(
    await session.client.execute(workspaces.createInvitation(workspaceId, principalId, role)),
    output,
  );
}

export async function acceptWorkspaceInvitation(
  profileName: string | undefined,
  workspaceId: string,
  invitationId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  await session.client.execute(workspaces.acceptInvitation(workspaceId, invitationId));
  printResult({ accepted: true, invitationId }, output);
}

export async function declineWorkspaceInvitation(
  profileName: string | undefined,
  workspaceId: string,
  invitationId: string,
  confirmed: boolean,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  assertConfirmed(confirmed);
  const session = await resolveSession(profileName, deps);
  await session.client.execute(workspaces.declineInvitation(workspaceId, invitationId));
  printResult({ declined: true, invitationId }, output);
}

export async function revokeWorkspaceInvitation(
  profileName: string | undefined,
  workspaceId: string,
  invitationId: string,
  confirmed: boolean,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  assertConfirmed(confirmed);
  const session = await resolveSession(profileName, deps);
  await session.client.execute(workspaces.revokeInvitation(workspaceId, invitationId));
  printResult({ revoked: true, invitationId }, output);
}

export async function listWorkspaceMembers(
  profileName: string | undefined,
  workspaceId: string,
  page: WorkspacePageOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  const result = await session.client.query(
    workspaces.listMembersPage(workspaceId, validatePage(page)),
  );
  printResult(
    { members: result.items, count: result.items.length, nextCursor: result.nextCursor },
    output,
  );
}

export async function changeWorkspaceMemberRole(
  profileName: string | undefined,
  workspaceId: string,
  principalId: string,
  role: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  assertUiRole(role);
  const session = await resolveSession(profileName, deps);
  printResult(
    await session.client.execute(workspaces.changeMemberRole(workspaceId, principalId, role)),
    output,
  );
}

export async function removeWorkspaceMember(
  profileName: string | undefined,
  workspaceId: string,
  principalId: string,
  confirmed: boolean,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  assertConfirmed(confirmed);
  const session = await resolveSession(profileName, deps);
  await session.client.execute(workspaces.removeMember(workspaceId, principalId));
  printResult({ removed: true, principalId }, output);
}

export async function leaveWorkspace(
  profileName: string | undefined,
  workspaceId: string,
  confirmed: boolean,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  assertConfirmed(confirmed);
  const session = await resolveSession(profileName, deps);
  await session.client.execute(workspaces.leaveWorkspace(workspaceId));
  printResult({ left: true, workspaceId }, output);
}

export interface WorkspacePageOptions {
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

function validatePage(page: WorkspacePageOptions): WorkspacePageOptions {
  const limit = page.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error('Page limit must be an integer from 1 through 200.');
  }
  if (page.cursor !== undefined && page.cursor.length > 512) {
    throw new Error('Cursor must not exceed 512 characters.');
  }
  return { limit, ...(page.cursor === undefined ? {} : { cursor: page.cursor }) };
}

function assertConfirmed(confirmed: boolean): void {
  if (!confirmed) {
    throw new Error('This destructive operation requires --yes.');
  }
}

function assertUiRole(role: string): asserts role is AssignableWorkspaceRole {
  if (role !== 'owner' && role !== 'editor' && role !== 'viewer')
    throw new Error("Role must be 'owner', 'editor', or 'viewer'.");
}
