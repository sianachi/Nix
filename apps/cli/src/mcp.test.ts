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
        'begin_template_draft',
        'get_template_draft',
        'update_template_draft',
        'update_template_draft_item',
        'save_template_draft',
        'discard_template_draft',
        'list_workspaces',
        'create_workspace',
        'rename_workspace',
        'list_workspace_invitations',
        'list_workspace_invitees',
        'invite_workspace_member',
        'accept_workspace_invitation',
        'decline_workspace_invitation',
        'revoke_workspace_invitation',
        'get_operation',
        'cancel_template_archive_import',
        'list_workspace_members',
        'set_habit',
        'set_habit_status',
        'read_habit',
        'check_in_habit',
        'undo_habit_check_in',
        'change_workspace_member_role',
        'remove_workspace_member',
        'list_workspace_assignable_principals',
        'leave_workspace',
        'import_document',
        'upload_file',
        'replace_file',
        'list_file_versions',
        'download_file',
        'list_templates',
        'get_template',
        'capture_template',
        'preflight_template_application',
        'apply_template',
        'set_template_initialization',
        'preview_template_archive_import',
        'get_template_archive_import',
        'commit_template_archive_import',
        'export_template_archive',
        'resume_template_file_copy',
      ]);
      expect(JSON.stringify(tools)).not.toContain('token');
      expect(JSON.stringify(tools)).not.toContain('authorization');
    } finally {
      await connected.close();
    }
  });

  it('exposes habit writes through the authenticated API session', async () => {
    const habitId = '11111111-1111-4111-8111-111111111111';
    const requests: { method: string; url: string; body: unknown }[] = [];
    const connected = await connect('owner', (url, init) => {
      if (url.endsWith('/public/v1/auth/token')) {
        return Promise.resolve(
          Response.json({
            accessToken: 'jwt-owner',
            tokenType: 'Bearer',
            expiresInSeconds: 600,
          }),
        );
      }
      requests.push({
        method: init?.method ?? 'GET',
        url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
      return Promise.resolve(
        Response.json({
          id: '22222222-2222-4222-8222-222222222222',
          occurredOn: '2026-09-14',
          completed: true,
          quantity: 2,
        }),
      );
    });
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      if (url.endsWith('/public/v1/auth/token')) {
        return Response.json({
          accessToken: 'jwt-owner',
          tokenType: 'Bearer',
          expiresInSeconds: 600,
        });
      }
      requests.push({
        method: init?.method ?? 'GET',
        url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
      return Response.json({
        id: '22222222-2222-4222-8222-222222222222',
        occurredOn: '2026-09-14',
        completed: true,
        quantity: 2,
      });
    });
    try {
      const result = await connected.client.callTool({
        name: 'check_in_habit',
        arguments: { habitId, occurredOn: '2026-09-14', completed: true, quantity: 2 },
      });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(requests).toEqual([
        {
          method: 'PUT',
          url: `http://nix.test/api/v1/items/${habitId}/habit/check-ins/2026-09-14`,
          body: { completed: true, quantity: 2 },
        },
      ]);
    } finally {
      await connected.close();
    }
  });

  it('preflights template input on Core and applies through the distinct Collab origin', async () => {
    const collab = 'http://collab.nix.test';
    const templateId = '33333333-3333-4333-8333-333333333333';
    const sourceId = '11111111-1111-4111-8111-111111111111';
    const urls: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      urls.push(url);
      if (url === `${API}/api/v1/templates/${templateId}`) {
        return Response.json({
          id: templateId,
          workspaceId: WORKSPACE,
          title: 'Project seed',
          description: null,
          origin: 'user',
          revision: 7,
          includeBody: false,
          includeChildren: false,
          fieldCount: 0,
          viewCount: 0,
          childCount: 0,
          viewKinds: [],
          capabilities: { canEdit: true, canDelete: true, canExport: true, canApply: true },
          updatedAt: '2026-09-20T09:00:00Z',
          initialization: { version: 1, inputs: [], rules: [], references: [] },
          root: {
            sourceId,
            itemType: 'note',
            title: 'Project seed',
            seq: '1',
            properties: {},
            schema: { properties: [], declared: [], inherit: false },
            views: null,
            hasBody: false,
            recurrence: null,
            children: [],
          },
        });
      }
      if (url === `${API}/api/v1/templates/${templateId}/preflight`) {
        return Response.json({
          templateId,
          templateRevision: 8,
          mode: 'create',
          additions: { fields: 0, views: 0, items: 1 },
          conflicts: [],
          canApply: true,
          initializationPreview: [],
          resolvedInputs: {},
          textBindings: {},
          referenceMappings: {},
        });
      }
      if (url === `${collab}/templates/applications`) {
        return Response.json({
          applicationId: '55555555-5555-4555-8555-555555555555',
          templateId,
          targetItemId: sourceId,
          alreadyApplied: false,
          createdItems: [{ sourceId, itemId: sourceId, itemType: 'note' }],
          resolvedInputs: {},
          textBindings: {},
          referenceMappings: {},
          writtenTargetItemIds: [],
          operationId: '44444444-4444-4444-8444-444444444444',
        });
      }
      throw new Error(`Unexpected route: ${url}`);
    });

    const connected = await connect(
      'owner',
      () =>
        Promise.resolve(
          Response.json({ accessToken: 'jwt-owner', tokenType: 'Bearer', expiresInSeconds: 600 }),
        ),
      collab,
    );
    try {
      const result = await connected.client.callTool({
        name: 'apply_template',
        arguments: { templateId, mode: 'create', inputs: {} },
      });
      expect(result.isError).not.toBe(true);
      const content = result.content as readonly {
        readonly type: string;
        readonly text?: string;
      }[];
      expect(
        JSON.parse(content[0]?.type === 'text' ? (content[0].text ?? '{}') : '{}'),
      ).toMatchObject({
        application: { applicationId: '55555555-5555-4555-8555-555555555555' },
        resume: { expectedRevision: 8 },
      });
      expect(urls).toContain(`${API}/api/v1/templates/${templateId}/preflight`);
      expect(urls).toContain(`${collab}/templates/applications`);
      expect(urls).not.toContain(`${collab}/collab/templates/applications`);
      expect(urls).not.toContain(`${API}/collab/templates/applications`);
    } finally {
      await connected.close();
    }
  });

  it('resumes a pending template draft from Core and replays the original begin command', async () => {
    const collab = 'http://collab.nix.test';
    const templateId = '33333333-3333-4333-8333-333333333333';
    const operationId = '44444444-4444-4444-8444-444444444444';
    const jobId = '55555555-5555-4555-8555-555555555555';
    const sourceId = '11111111-1111-4111-8111-111111111111';
    const collabBodies: unknown[] = [];
    const urls: string[] = [];
    let beginCount = 0;
    const fetchImpl: FetchImpl = (url, init) => {
      urls.push(url);
      if (url.endsWith('/public/v1/auth/token')) {
        return Promise.resolve(
          Response.json({ accessToken: 'jwt-owner', tokenType: 'Bearer', expiresInSeconds: 600 }),
        );
      }
      if (url === `${collab}/templates/${templateId}/drafts`) {
        collabBodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : null);
        beginCount += 1;
        return Promise.resolve(
          Response.json(
            {
              operationId,
              templateId,
              fileTransferJobId: beginCount === 1 ? jobId : null,
              fileTransferPending: beginCount === 1,
              title: 'Project seed',
              description: null,
              initialization: { version: 1, inputs: [], rules: [], references: [] },
              expiresAt: '2026-09-20T10:00:00Z',
              root: {
                sourceId,
                itemType: 'note',
                title: 'Project seed',
                seq: '1',
                properties: {},
                schema: null,
                views: null,
                hasBody: false,
                recurrence: null,
                children: [],
              },
              itemMappings: [],
              bodyCopies: [],
            },
            { status: beginCount === 1 ? 202 : 201 },
          ),
        );
      }
      if (url === `${API}/api/v1/operations/${jobId}`) {
        return Promise.resolve(
          Response.json({
            id: jobId,
            kind: 'template.files.copy',
            status: 'completed',
            result: null,
            errorCode: null,
            errorDetail: null,
            attempts: 1,
            cancellationRequested: false,
            createdAt: '2026-09-20T09:00:00Z',
            completedAt: '2026-09-20T09:00:01Z',
          }),
        );
      }
      return Promise.reject(new Error(`Unexpected route: ${url}`));
    };

    vi.stubGlobal('fetch', fetchImpl);
    const connected = await connect('owner', fetchImpl, collab);
    try {
      const result = await connected.client.callTool({
        name: 'begin_template_draft',
        arguments: { templateId, idempotencyKey: 'draft-resume-key' },
      });
      expect(result.isError, JSON.stringify({ result, urls, collabBodies })).not.toBe(true);
      expect(beginCount).toBe(1);
      const receiptText =
        (result.content as readonly { type: string; text?: string }[])[0]?.text ?? '{}';
      const receipt = JSON.parse(receiptText) as {
        resume: { kind: string; jobId: string; request: unknown };
      };
      expect(receipt.resume).toMatchObject({
        kind: 'draft',
        jobId,
        request: { idempotencyKey: 'draft-resume-key', templateId },
      });
      const resumed = await connected.client.callTool({
        name: 'resume_template_file_copy',
        arguments: receipt.resume,
      });
      expect(resumed.isError, JSON.stringify(resumed)).not.toBe(true);
      expect(beginCount).toBe(2);
      expect(collabBodies).toEqual([
        { idempotencyKey: 'draft-resume-key' },
        { idempotencyKey: 'draft-resume-key' },
      ]);
      expect(urls).toContain(`${API}/api/v1/operations/${jobId}`);
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
        return Promise.resolve(
          Response.json({
            accessToken: body.token === 'nixpat_owner' ? 'jwt-owner' : 'jwt-outsider',
            tokenType: 'Bearer',
            expiresInSeconds: 600,
          }),
        );
      }

      const headers = new Headers(init?.headers);
      const authorization = headers.get('authorization') ?? '';
      authorizationHeaders.push(authorization);
      if (authorization === 'Bearer jwt-owner') {
        return Promise.resolve(Response.json({ items: [workspace()], nextCursor: null }));
      }
      return Promise.resolve(
        Response.json(
          { code: 'workspaces.not_found', detail: 'No workspace is visible.' },
          { status: 403 },
        ),
      );
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

async function connect(profileName: string, fetchImpl: FetchImpl, collabUrl?: string) {
  const server = await createWorkspaceMcpServer({
    profileName,
    resolve: (requestedProfile) =>
      Promise.resolve(
        openSession({
          profile: {
            apiUrl: API,
            ...(collabUrl === undefined ? {} : { collabUrl }),
            token: requestedProfile === 'owner' ? 'nixpat_owner' : 'nixpat_outsider',
          },
          fetchImpl,
        }),
      ),
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
    canUseDailyNotes: true,
    pendingInvitationId: null,
    lifecycleState: 'active',
    archivedAt: null,
  };
}

function unexpectedRequest(): Promise<Response> {
  return Promise.reject(new Error('No request was expected.'));
}
