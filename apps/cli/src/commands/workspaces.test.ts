import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveProfile } from '../config.ts';
import { outputOptions } from '../output.ts';
import {
  acceptWorkspaceInvitation,
  archiveWorkspace,
  changeWorkspaceMemberRole,
  createWorkspace,
  declineWorkspaceInvitation,
  inviteWorkspaceMember,
  leaveWorkspace,
  listWorkspaceInvitees,
  listWorkspaceInvitations,
  listWorkspaceMembers,
  purgeWorkspace,
  removeWorkspaceMember,
  renameWorkspace,
  restoreWorkspace,
  revokeWorkspaceInvitation,
} from './workspaces.ts';

const API = 'http://nix.test';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const PRINCIPAL = '33333333-3333-4333-8333-333333333333';
const INVITATION = '44444444-4444-4444-8444-444444444444';

const server = setupServer(
  http.post(`${API}/public/v1/auth/token`, () =>
    HttpResponse.json({ accessToken: 'jwt-1', tokenType: 'Bearer', expiresInSeconds: 600 }),
  ),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

describe('workspace administration commands', () => {
  it('creates and renames shared workspaces through the generated client', async () => {
    const profile = await withProfile();
    const bodies: unknown[] = [];
    server.use(
      http.post(`${API}/api/v1/workspaces`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(workspace('Created'), { status: 201 });
      }),
      http.patch(`${API}/api/v1/workspaces/:workspaceId`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(workspace('Renamed'));
      }),
    );

    expect(
      await capture((json) => createWorkspace('default', 'Created', json, profile.deps)),
    ).toMatchObject({
      name: 'Created',
    });
    expect(
      await capture((json) => renameWorkspace('default', WORKSPACE, 'Renamed', json, profile.deps)),
    ).toMatchObject({ name: 'Renamed' });
    expect(bodies).toEqual([{ name: 'Created' }, { name: 'Renamed' }]);
    await profile.done();
  });

  it('archives, restores, then permanently deletes a workspace through the lifecycle endpoints', async () => {
    const profile = await withProfile();
    server.use(
      http.post(`${API}/api/v1/workspaces/:workspaceId/archive`, () =>
        HttpResponse.json(workspace('Archived', 'archived')),
      ),
      http.post(`${API}/api/v1/workspaces/:workspaceId/restore`, () =>
        HttpResponse.json(workspace('Restored', 'active')),
      ),
      http.delete(`${API}/api/v1/workspaces/:workspaceId`, () => new HttpResponse(null, { status: 202 })),
    );

    expect(
      await capture((json) => archiveWorkspace('default', WORKSPACE, true, json, profile.deps)),
    ).toMatchObject({ lifecycleState: 'archived' });
    expect(
      await capture((json) => restoreWorkspace('default', WORKSPACE, json, profile.deps)),
    ).toMatchObject({ lifecycleState: 'active' });
    expect(
      await capture((json) => purgeWorkspace('default', WORKSPACE, true, json, profile.deps)),
    ).toEqual({ purging: true, workspaceId: WORKSPACE });
    await profile.done();
  });

  it('lists, creates, and revokes invitations while preserving history responses', async () => {
    const profile = await withProfile();
    let inviteBody: unknown;
    server.use(
      http.get(`${API}/api/v1/workspaces/:workspaceId/invitations`, () =>
        HttpResponse.json({ items: [invitation()], nextCursor: null }),
      ),
      http.post(`${API}/api/v1/workspaces/:workspaceId/invitations`, async ({ request }) => {
        inviteBody = await request.json();
        return HttpResponse.json(invitation(), { status: 201 });
      }),
      http.delete(
        `${API}/api/v1/workspaces/:workspaceId/invitations/:invitationId`,
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    expect(
      await capture((json) =>
        listWorkspaceInvitations('default', WORKSPACE, {}, json, profile.deps),
      ),
    ).toMatchObject({ count: 1 });
    expect(
      await capture((json) =>
        inviteWorkspaceMember('default', WORKSPACE, PRINCIPAL, 'editor', json, profile.deps),
      ),
    ).toMatchObject({ id: INVITATION, status: 'pending' });
    expect(inviteBody).toEqual({ principalId: PRINCIPAL, role: 'editor' });
    expect(
      await capture((json) =>
        revokeWorkspaceInvitation('default', WORKSPACE, INVITATION, true, json, profile.deps),
      ),
    ).toEqual({ revoked: true, invitationId: INVITATION });
    await profile.done();
  });

  it('lists eligible people and lets the recipient accept or decline an invitation', async () => {
    const profile = await withProfile();
    server.use(
      http.get(`${API}/api/v1/workspaces/:workspaceId/invitees`, () =>
        HttpResponse.json({ items: [invitee()], nextCursor: null }),
      ),
      http.post(
        `${API}/api/v1/workspaces/:workspaceId/invitations/:invitationId/accept`,
        () => new HttpResponse(null, { status: 204 }),
      ),
      http.post(
        `${API}/api/v1/workspaces/:workspaceId/invitations/:invitationId/decline`,
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    expect(
      await capture((json) => listWorkspaceInvitees('default', WORKSPACE, {}, json, profile.deps)),
    ).toMatchObject({
      count: 1,
      invitees: [{ principalId: PRINCIPAL, displayName: 'Collaborator' }],
    });
    expect(
      await capture((json) =>
        acceptWorkspaceInvitation('default', WORKSPACE, INVITATION, json, profile.deps),
      ),
    ).toEqual({ accepted: true, invitationId: INVITATION });
    expect(
      await capture((json) =>
        declineWorkspaceInvitation('default', WORKSPACE, INVITATION, true, json, profile.deps),
      ),
    ).toEqual({ declined: true, invitationId: INVITATION });
    await profile.done();
  });

  it('lists capability-bearing members, changes roles, and removes members', async () => {
    const profile = await withProfile();
    let roleBody: unknown;
    server.use(
      http.get(`${API}/api/v1/workspaces/:workspaceId/members`, () =>
        HttpResponse.json({ items: [member('viewer')], nextCursor: null }),
      ),
      http.patch(
        `${API}/api/v1/workspaces/:workspaceId/members/:principalId`,
        async ({ request }) => {
          roleBody = await request.json();
          return HttpResponse.json(member('editor'));
        },
      ),
      http.delete(
        `${API}/api/v1/workspaces/:workspaceId/members/:principalId`,
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    expect(
      await capture((json) => listWorkspaceMembers('default', WORKSPACE, {}, json, profile.deps)),
    ).toMatchObject({
      count: 1,
      members: [
        { canChangeRole: true, canRemove: true, assignableRoles: ['owner', 'editor', 'viewer'] },
      ],
    });
    expect(
      await capture((json) =>
        changeWorkspaceMemberRole('default', WORKSPACE, PRINCIPAL, 'editor', json, profile.deps),
      ),
    ).toMatchObject({ role: 'editor' });
    expect(roleBody).toEqual({ role: 'editor' });
    expect(
      await capture((json) =>
        removeWorkspaceMember('default', WORKSPACE, PRINCIPAL, true, json, profile.deps),
      ),
    ).toEqual({ removed: true, principalId: PRINCIPAL });
    await profile.done();
  });

  it('refuses commenter on the new CLI assignment surface before opening a session', async () => {
    await expect(
      inviteWorkspaceMember(undefined, WORKSPACE, PRINCIPAL, 'commenter', outputOptions(true)),
    ).rejects.toThrow("Role must be 'owner', 'editor', or 'viewer'.");
  });

  it('requires explicit acknowledgement for every destructive workspace command', async () => {
    await expect(
      revokeWorkspaceInvitation(undefined, WORKSPACE, INVITATION, false, outputOptions(true)),
    ).rejects.toThrow('requires --yes');
    await expect(
      declineWorkspaceInvitation(undefined, WORKSPACE, INVITATION, false, outputOptions(true)),
    ).rejects.toThrow('requires --yes');
    await expect(
      removeWorkspaceMember(undefined, WORKSPACE, PRINCIPAL, false, outputOptions(true)),
    ).rejects.toThrow('requires --yes');
    await expect(leaveWorkspace(undefined, WORKSPACE, false, outputOptions(true))).rejects.toThrow(
      'requires --yes',
    );
    await expect(archiveWorkspace(undefined, WORKSPACE, false, outputOptions(true))).rejects.toThrow(
      'requires --yes',
    );
    await expect(purgeWorkspace(undefined, WORKSPACE, false, outputOptions(true))).rejects.toThrow(
      'requires --yes',
    );
  });
});

async function capture(body: (json: ReturnType<typeof outputOptions>) => Promise<void>) {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return true;
  });
  try {
    await body(outputOptions(true, { isTTY: false }));
  } finally {
    spy.mockRestore();
  }
  return JSON.parse(lines.join('')) as unknown;
}

async function withProfile() {
  const dir = await mkdtemp(join(tmpdir(), 'nixctl-workspaces-'));
  const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: dir };
  await saveProfile('default', { apiUrl: API, token: 'nixpat_test' }, { makeDefault: true, env });
  return {
    deps: { env },
    done: () => rm(dir, { recursive: true, force: true }),
  };
}

function workspace(name: string, lifecycleState: 'active' | 'archived' = 'active'): Record<string, unknown> {
  return {
    id: WORKSPACE,
    name,
    versionRetentionDays: 90,
    storageQuotaBytes: '10737418240',
    createdAt: '2026-08-30T12:00:00Z',
    kind: 'shared',
    canRename: true,
    canManageMembers: true,
    canLeave: false,
    canUseDailyNotes: true,
    pendingInvitationId: null,
    lifecycleState,
    archivedAt: lifecycleState === 'archived' ? '2026-09-06T12:00:00Z' : null,
  };
}

function invitation(): Record<string, unknown> {
  return {
    id: INVITATION,
    emailNormalized: 'person@example.test',
    targetPrincipalId: PRINCIPAL,
    role: 'editor',
    status: 'pending',
    invitedByPrincipalId: PRINCIPAL,
    invitedAt: '2026-08-30T12:00:00Z',
    acceptedAt: null,
    acceptedByPrincipalId: null,
    revokedAt: null,
  };
}

function invitee(): Record<string, unknown> {
  return {
    principalId: PRINCIPAL,
    displayName: 'Collaborator',
    email: 'person@example.test',
  };
}

function member(role: string): Record<string, unknown> {
  return {
    subjectType: 'principal',
    subjectId: PRINCIPAL,
    subjectDisplayName: 'Collaborator',
    email: 'person@example.test',
    role,
    grantedAt: '2026-08-30T12:00:00Z',
    canChangeRole: true,
    canRemove: true,
    assignableRoles: ['owner', 'editor', 'viewer'],
  };
}
