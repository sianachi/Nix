import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWorkspaceMcpServer } from './mcp.ts';
import { openSession, type FetchImpl } from './session.ts';

const API = 'http://nix.test';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('nixctl mcp workspace tools', () => {
  it('publishes the workspace administration surface without credential arguments', async () => {
    const connected = await connect('owner', async () => unexpectedRequest());
    try {
      const tools = await connected.client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        'list_workspaces',
        'create_workspace',
        'rename_workspace',
        'list_workspace_invitations',
        'invite_workspace_member',
        'revoke_workspace_invitation',
        'list_workspace_members',
        'change_workspace_member_role',
        'remove_workspace_member',
        'leave_workspace',
      ]);
      expect(JSON.stringify(tools)).not.toContain('token');
      expect(JSON.stringify(tools)).not.toContain('authorization');
    } finally {
      await connected.close();
    }
  });

  it('carries only exchanged JWTs and preserves Core authorization between two principals', async () => {
    const authorizationHeaders: string[] = [];
    const fetchImpl: FetchImpl = (url, init) => {
      if (url.endsWith('/public/v1/auth/token')) {
        if (typeof init?.body !== 'string') {
          return Promise.reject(new Error('Expected a JSON exchange body.'));
        }
        const body = JSON.parse(init.body) as { token: string };
        return Promise.resolve(Response.json({
          accessToken: body.token === 'nixpat_owner' ? 'jwt-owner' : 'jwt-outsider',
          tokenType: 'Bearer',
          expiresInSeconds: 600,
        }));
      }

      const headers = new Headers(init?.headers);
      const authorization = headers.get('authorization') ?? '';
      authorizationHeaders.push(authorization);
      if (authorization === 'Bearer jwt-owner') {
        return Promise.resolve(Response.json({ items: [workspace()], nextCursor: null }));
      }
      return Promise.resolve(Response.json(
        { code: 'workspaces.not_found', detail: 'No workspace is visible.' },
        { status: 403 },
      ));
    };
    vi.stubGlobal('fetch', fetchImpl);

    const owner = await connect('owner', fetchImpl);
    const outsider = await connect('outsider', fetchImpl);
    try {
      const allowed = await owner.client.callTool({ name: 'list_workspaces', arguments: {} });
      const refused = await outsider.client.callTool({ name: 'list_workspaces', arguments: {} });

      expect(allowed.isError, JSON.stringify(allowed)).not.toBe(true);
      expect(JSON.stringify(allowed.content)).toContain(WORKSPACE);
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toContain('status 403');
      expect(authorizationHeaders).toEqual(['Bearer jwt-owner', 'Bearer jwt-outsider']);
      expect(JSON.stringify({ allowed, refused, authorizationHeaders })).not.toContain('nixpat_');
    } finally {
      await owner.close();
      await outsider.close();
    }
  });

  it('bounds paging inputs and requires confirm true for destructive tools', async () => {
    const connected = await connect('owner', async () => unexpectedRequest());
    try {
      const oversizedCursor = await connected.client.callTool({
        name: 'list_workspace_members',
        arguments: { workspaceId: WORKSPACE, cursor: 'x'.repeat(513) },
      });
      const unconfirmed = await connected.client.callTool({
        name: 'leave_workspace',
        arguments: { workspaceId: WORKSPACE },
      });
      expect(oversizedCursor.isError).toBe(true);
      expect(unconfirmed.isError).toBe(true);
    } finally {
      await connected.close();
    }
  });
});

async function connect(profileName: string, fetchImpl: FetchImpl) {
  const server = await createWorkspaceMcpServer({
    profileName,
    resolve: (requestedProfile) =>
      Promise.resolve(openSession({
        profile: {
          apiUrl: API,
          token: requestedProfile === 'owner' ? 'nixpat_owner' : 'nixpat_outsider',
        },
        fetchImpl,
      })),
  });
  const client = new Client({ name: 'nixctl-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function workspace(): Record<string, unknown> {
  return {
    id: WORKSPACE,
    name: 'Owner workspace',
    versionRetentionDays: 90,
    storageQuotaBytes: '10737418240',
    createdAt: '2026-08-30T12:00:00Z',
    kind: 'personal',
    canRename: true,
    canManageMembers: true,
    canLeave: false,
  };
}

function unexpectedRequest(): Promise<Response> {
  return Promise.reject(new Error('No request was expected.'));
}
