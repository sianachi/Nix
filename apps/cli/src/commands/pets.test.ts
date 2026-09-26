import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveProfile } from '../config.ts';
import { outputOptions } from '../output.ts';
import { petCommand, petToolRun } from './pets.ts';

const CORE = 'http://core.nix.test';
const COLLAB = 'http://collab.nix.test';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const PET = '33333333-3333-4333-8333-333333333333';
const TOOL = 'tool-1';

const server = setupServer(
  http.post(`${CORE}/public/v1/auth/token`, () =>
    HttpResponse.json({ accessToken: 'jwt-1', tokenType: 'Bearer', expiresInSeconds: 600 }),
  ),
);
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => {
  server.close();
});

describe('pet commands', () => {
  it('uses an explicit interactive token without storing it or widening PAT permissions', async () => {
    let payload: unknown;
    server.use(
      http.post('http://nix.test/api/v1/me/pets/runtime', async ({ request }) => {
        expect(request.headers.get('authorization')).toBe('Bearer ephemeral-session');
        payload = await request.json();
        return HttpResponse.json({
          provider: 'chatgpt',
          status: 'connected',
          reason: 'Connected',
          canConnect: false,
        });
      }),
    );
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await petCommand(
      undefined,
      'send',
      {
        apiUrl: 'http://nix.test',
        workspace: '11111111-1111-4111-8111-111111111111',
        pet: '22222222-2222-4222-8222-222222222222',
        message: 'Make a plan',
        workspaceTools: true,
        model: 'account-model',
      },
      { json: true, isTty: false },
      { env: { NIX_SESSION_TOKEN: 'ephemeral-session' } },
    );
    expect(payload).toMatchObject({
      operation: 'send',
      text: 'Make a plan',
      workspaceAccess: true,
      model: 'account-model',
    });
    expect(output).toHaveBeenCalled();
  });
  it('rejects unknown operations before contacting the service', async () => {
    await expect(petCommand(undefined, 'exec', {}, { json: true, isTty: false })).rejects.toThrow(
      'Choose a pet operation',
    );
  });
  it('forwards a pending tool_claim/tool_result pair and an explicit consult mode', async () => {
    const calls: Record<string, unknown>[] = [];
    server.use(
      http.post(`${CORE}/api/v1/me/pets/runtime`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        calls.push(body);
        return HttpResponse.json({
          provider: 'chatgpt',
          status: 'connected',
          reason: 'Connected',
          canConnect: false,
          mode: body.mode,
        });
      }),
    );
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await petCommand(
      undefined,
      'tool_claim',
      { apiUrl: CORE, workspace: WORKSPACE, pet: PET, toolId: TOOL, requestId: 'req-1' },
      { json: true, isTty: false },
      { env: { NIX_SESSION_TOKEN: 'ephemeral-session' } },
    );
    await petCommand(
      undefined,
      'tool_result',
      {
        apiUrl: CORE,
        workspace: WORKSPACE,
        pet: PET,
        toolId: TOOL,
        requestId: 'req-1',
        toolResult: 'done',
        toolSuccess: true,
      },
      { json: true, isTty: false },
      { env: { NIX_SESSION_TOKEN: 'ephemeral-session' } },
    );
    await petCommand(
      undefined,
      'read',
      { apiUrl: CORE, workspace: WORKSPACE, pet: PET, mode: 'consult' },
      { json: true, isTty: false },
      { env: { NIX_SESSION_TOKEN: 'ephemeral-session' } },
    );
    expect(calls.map((call) => call.operation)).toEqual(['tool_claim', 'tool_result', 'read']);
    expect(calls[0]).toMatchObject({
      workspaceId: WORKSPACE,
      petId: PET,
      toolId: TOOL,
      requestId: 'req-1',
      mode: '',
    });
    expect(calls[1]).toMatchObject({
      toolId: TOOL,
      requestId: 'req-1',
      toolResult: 'done',
      toolSuccess: true,
    });
    expect(calls[2]).toMatchObject({ workspaceId: WORKSPACE, petId: PET, mode: 'consult' });
    expect(output).toHaveBeenCalled();
  });
  it('rejects a malformed --mode before contacting the service', async () => {
    await expect(
      petCommand(undefined, 'read', { mode: 'design' }, { json: true, isTty: false }),
    ).rejects.toThrow('--mode must be chat or consult');
  });
  it('rejects tool_claim and tool_result before contacting the service when --tool-id is missing', async () => {
    await expect(
      petCommand(
        undefined,
        'tool_claim',
        { apiUrl: CORE, workspace: WORKSPACE, pet: PET },
        { json: true, isTty: false },
        { env: { NIX_SESSION_TOKEN: 'ephemeral-session' } },
      ),
    ).rejects.toThrow('Provide --tool-id.');
    await expect(
      petCommand(
        undefined,
        'tool_result',
        { apiUrl: CORE, workspace: WORKSPACE, pet: PET, toolId: TOOL },
        { json: true, isTty: false },
        { env: { NIX_SESSION_TOKEN: 'ephemeral-session' } },
      ),
    ).rejects.toThrow('Provide --tool-id and --tool-result.');
  });
});

async function withProfile(): Promise<{ env: NodeJS.ProcessEnv; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'nixctl-pets-'));
  const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: dir };
  await saveProfile(
    'default',
    { apiUrl: CORE, collabUrl: COLLAB, token: 'nixpat_abc' },
    { makeDefault: true, env },
  );
  return { env, done: () => rm(dir, { recursive: true, force: true }) };
}

async function capture(body: () => Promise<void>): Promise<unknown> {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return true;
  });
  try {
    await body();
    return JSON.parse(lines.join(''));
  } finally {
    spy.mockRestore();
  }
}

function listItemsArgs(): string {
  return JSON.stringify({
    operation: 'list_items',
    itemId: '',
    parentId: '',
    title: '',
    markdown: '',
    query: '',
    propertiesJson: '',
  });
}

function pendingTool(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TOOL,
    arguments: listItemsArgs(),
    status: 'pending',
    result: '',
    claimId: '',
    ...overrides,
  };
}

function runtimeResponse(tools: unknown[]): Record<string, unknown> {
  return {
    provider: 'chatgpt',
    status: 'connected',
    reason: 'Connected',
    canConnect: false,
    tools,
  };
}

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: WORKSPACE,
    parentId: null,
    type: 'note',
    title: 'Kickoff',
    hasChildren: false,
    seq: 1000,
    lifecycleState: 'active',
    properties: {},
    createdAt: '2026-08-19T09:00:00.000Z',
    updatedAt: '2026-08-19T09:00:00.000Z',
    ...overrides,
  };
}

describe('pet tools run', () => {
  it('dry run prints the preview and performs no runtime write', async () => {
    const profile = await withProfile();
    try {
      const calls: string[] = [];
      server.use(
        http.post(`${CORE}/api/v1/me/pets/runtime`, async ({ request }) => {
          const body = (await request.json()) as { operation: string };
          calls.push(body.operation);
          return HttpResponse.json(runtimeResponse([pendingTool()]));
        }),
      );
      const result = await capture(() =>
        petToolRun(
          'default',
          TOOL,
          { workspace: WORKSPACE, pet: PET },
          outputOptions(true, { isTTY: false }),
          { env: profile.env },
        ),
      );
      expect(calls).toEqual(['read']);
      expect(result).toMatchObject({
        toolId: TOOL,
        status: 'pending',
        preview: 'I will list the top-level items in this workspace to find what to work on.',
      });
    } finally {
      await profile.done();
    }
  });

  it.each([
    [
      { operation: 'list_templates', query: 'reading log' },
      'I will look through your templates for “reading log” to see what fits.',
    ],
    [
      { operation: 'list_templates', query: '' },
      'I will look through your templates to see what fits.',
    ],
    [
      { operation: 'read_template', itemId: '11111111-1111-4111-8111-111111111111' },
      'I will read the linked template’s outline to see if it fits.',
    ],
    [
      {
        operation: 'apply_template',
        itemId: '11111111-1111-4111-8111-111111111111',
        title: 'Reading log',
      },
      'I will create “Reading log” from the linked template at the top level of this workspace.',
    ],
    [
      { operation: 'read_structure', itemId: '11111111-1111-4111-8111-111111111111' },
      "I will read the linked item's fields, views and how many children it has.",
    ],
    [
      {
        operation: 'create_structured',
        title: 'Reading log',
        specJson: '{"recipe":"board","fields":[]}',
      },
      'I will create a structured item named “Reading log” at the top level of this workspace.',
    ],
    [
      {
        operation: 'add_view',
        itemId: '11111111-1111-4111-8111-111111111111',
        specJson: '{"views":[{"kind":"list"}]}',
      },
      'I will add the view described below to the linked item.',
    ],
    [
      {
        operation: 'create_entries',
        parentId: '11111111-1111-4111-8111-111111111111',
        specJson: '{"entries":[{"title":"First"}]}',
      },
      'I will add the entries described below to the linked destination.',
    ],
    [
      {
        operation: 'add_fields',
        itemId: '11111111-1111-4111-8111-111111111111',
        specJson: '{"fields":[]}',
      },
      'I will add the fields described below to the linked item, leaving existing fields unchanged.',
    ],
    [
      {
        operation: 'edit_form',
        itemId: '11111111-1111-4111-8111-111111111111',
        specJson: '{"viewId":"form","form":{"pages":[]}}',
      },
      'I will update the linked form as described below, preserving its companion view.',
    ],
    [
      {
        operation: 'set_recurrence',
        itemId: '11111111-1111-4111-8111-111111111111',
        specJson: '{"frequency":"weekly","interval":2}',
      },
      'I will make the linked item repeat according to the schedule described below.',
    ],
  ])('previews %o the same way the web approval card does', async (overrides, preview) => {
    const profile = await withProfile();
    try {
      server.use(
        http.post(`${CORE}/api/v1/me/pets/runtime`, () =>
          HttpResponse.json(
            runtimeResponse([
              pendingTool({
                arguments: JSON.stringify({
                  itemId: '',
                  parentId: '',
                  title: '',
                  markdown: '',
                  query: '',
                  propertiesJson: '',
                  ...overrides,
                }),
              }),
            ]),
          ),
        ),
      );
      const result = await capture(() =>
        petToolRun(
          'default',
          TOOL,
          { workspace: WORKSPACE, pet: PET },
          outputOptions(true, { isTTY: false }),
          { env: profile.env },
        ),
      );
      expect(result).toMatchObject({ toolId: TOOL, preview });
    } finally {
      await profile.done();
    }
  });

  it('previews with an interactive apiUrl/NIX_SESSION_TOKEN session and no stored profile', async () => {
    const calls: string[] = [];
    server.use(
      http.post(`${CORE}/api/v1/me/pets/runtime`, async ({ request }) => {
        expect(request.headers.get('authorization')).toBe('Bearer ephemeral-session');
        const body = (await request.json()) as { operation: string };
        calls.push(body.operation);
        return HttpResponse.json(runtimeResponse([pendingTool()]));
      }),
    );
    const result = await capture(() =>
      petToolRun(
        undefined,
        TOOL,
        { apiUrl: CORE, workspace: WORKSPACE, pet: PET },
        outputOptions(true, { isTTY: false }),
        { env: { NIX_SESSION_TOKEN: 'ephemeral-session' } },
      ),
    );
    expect(calls).toEqual(['read']);
    expect(result).toMatchObject({ toolId: TOOL, status: 'pending' });
  });

  it('claims before executing and never runs when the claim receipt does not match', async () => {
    const profile = await withProfile();
    try {
      const calls: string[] = [];
      server.use(
        http.post(`${CORE}/api/v1/me/pets/runtime`, async ({ request }) => {
          const body = (await request.json()) as { operation: string };
          calls.push(body.operation);
          if (body.operation === 'read') return HttpResponse.json(runtimeResponse([pendingTool()]));
          if (body.operation === 'tool_claim')
            // A stale or lost claim response: the receipt names someone else's claim.
            return HttpResponse.json(
              runtimeResponse([pendingTool({ status: 'claimed', claimId: 'someone-elses-claim' })]),
            );
          throw new Error(`Unexpected operation ${body.operation}`);
        }),
      );
      await expect(
        petToolRun(
          'default',
          TOOL,
          { workspace: WORKSPACE, pet: PET, approve: true },
          outputOptions(true, { isTTY: false }),
          { env: profile.env },
        ),
      ).rejects.toThrow('Tool was claimed elsewhere.');
      expect(calls).toEqual(['read', 'tool_claim']);
    } finally {
      await profile.done();
    }
  });

  it('posts a declined result without executing', async () => {
    const profile = await withProfile();
    try {
      const calls: { operation: string; body: Record<string, unknown> }[] = [];
      server.use(
        http.post(`${CORE}/api/v1/me/pets/runtime`, async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          calls.push({ operation: body.operation as string, body });
          if (body.operation === 'read') return HttpResponse.json(runtimeResponse([pendingTool()]));
          if (body.operation === 'tool_claim')
            return HttpResponse.json(
              runtimeResponse([pendingTool({ status: 'claimed', claimId: body.requestId })]),
            );
          if (body.operation === 'tool_result')
            return HttpResponse.json(
              runtimeResponse([
                pendingTool({ status: 'failed', result: body.toolResult as string }),
              ]),
            );
          throw new Error(`Unexpected operation ${String(body.operation)}`);
        }),
      );
      const result = await capture(() =>
        petToolRun(
          'default',
          TOOL,
          { workspace: WORKSPACE, pet: PET, decline: true },
          outputOptions(true, { isTTY: false }),
          { env: profile.env },
        ),
      );
      expect(calls.map((call) => call.operation)).toEqual(['read', 'tool_claim', 'tool_result']);
      const resultCall = calls[2];
      expect(resultCall?.body).toMatchObject({
        toolResult: 'Declined by the user. Do not retry this change unless asked.',
        toolSuccess: false,
      });
      expect(result).toBeDefined();
    } finally {
      await profile.done();
    }
  });

  it('posts the uncertain-outcome sentence and success false when execution throws', async () => {
    const profile = await withProfile();
    try {
      const calls: { operation: string; body: Record<string, unknown> }[] = [];
      server.use(
        http.post(`${CORE}/api/v1/me/pets/runtime`, async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          calls.push({ operation: body.operation as string, body });
          if (body.operation === 'read')
            return HttpResponse.json(
              runtimeResponse([
                pendingTool({
                  arguments: JSON.stringify({
                    operation: 'read_item',
                    itemId: '11111111-1111-4111-8111-111111111111',
                    parentId: '',
                    title: '',
                    markdown: '',
                    query: '',
                    propertiesJson: '',
                  }),
                }),
              ]),
            );
          if (body.operation === 'tool_claim')
            return HttpResponse.json(
              runtimeResponse([pendingTool({ status: 'claimed', claimId: body.requestId })]),
            );
          if (body.operation === 'tool_result')
            return HttpResponse.json(
              runtimeResponse([
                pendingTool({ status: 'failed', result: body.toolResult as string }),
              ]),
            );
          throw new Error(`Unexpected operation ${String(body.operation)}`);
        }),
        // The executor's own read of the target item fails with a server error: the outcome
        // is uncertain, not a `WorkspaceToolRefusal` and not a success.
        http.get(`${CORE}/api/v1/items/11111111-1111-4111-8111-111111111111`, () =>
          HttpResponse.json({ code: 'server_error', detail: 'boom' }, { status: 500 }),
        ),
      );
      const result = await capture(() =>
        petToolRun(
          'default',
          TOOL,
          { workspace: WORKSPACE, pet: PET, approve: true },
          outputOptions(true, { isTTY: false }),
          { env: profile.env },
        ),
      );
      const resultCall = calls[2];
      expect(resultCall?.body).toMatchObject({
        toolResult:
          'The operation failed or its result is uncertain. Inspect Nix before retrying a write. Do not assume success.',
        toolSuccess: false,
      });
      expect(result).toBeDefined();
    } finally {
      await profile.done();
    }
  });

  it('posts the outcome text and success true after an approved read-only write executes', async () => {
    const profile = await withProfile();
    try {
      const calls: { operation: string; body: Record<string, unknown> }[] = [];
      server.use(
        http.post(`${CORE}/api/v1/me/pets/runtime`, async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          calls.push({ operation: body.operation as string, body });
          if (body.operation === 'read') return HttpResponse.json(runtimeResponse([pendingTool()]));
          if (body.operation === 'tool_claim')
            return HttpResponse.json(
              runtimeResponse([pendingTool({ status: 'claimed', claimId: body.requestId })]),
            );
          if (body.operation === 'tool_result')
            return HttpResponse.json(
              runtimeResponse([
                pendingTool({ status: 'completed', result: body.toolResult as string }),
              ]),
            );
          throw new Error(`Unexpected operation ${String(body.operation)}`);
        }),
        http.get(`${CORE}/api/v1/workspaces/${WORKSPACE}/items`, () =>
          HttpResponse.json({ items: [item()], nextCursor: null }),
        ),
      );
      const result = await capture(() =>
        petToolRun(
          'default',
          TOOL,
          { workspace: WORKSPACE, pet: PET, approve: true },
          outputOptions(true, { isTTY: false }),
          { env: profile.env },
        ),
      );
      const resultCall = calls[2];
      expect(resultCall?.body).toMatchObject({ toolSuccess: true });
      expect(JSON.parse(resultCall?.body.toolResult as string)).toMatchObject({
        truncated: false,
        items: [{ id: item().id, title: 'Kickoff' }],
      });
      expect(result).toBeDefined();
    } finally {
      await profile.done();
    }
  });

  it('reports the local refusal message when the target is outside the workspace', async () => {
    const profile = await withProfile();
    const otherItem = '44444444-4444-4444-8444-444444444444';
    try {
      const calls: { operation: string; body: Record<string, unknown> }[] = [];
      server.use(
        http.post(`${CORE}/api/v1/me/pets/runtime`, async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          calls.push({ operation: body.operation as string, body });
          if (body.operation === 'read')
            return HttpResponse.json(
              runtimeResponse([
                pendingTool({
                  arguments: JSON.stringify({
                    operation: 'list_items',
                    itemId: '',
                    parentId: otherItem,
                    title: '',
                    markdown: '',
                    query: '',
                    propertiesJson: '',
                  }),
                }),
              ]),
            );
          if (body.operation === 'tool_claim')
            return HttpResponse.json(
              runtimeResponse([pendingTool({ status: 'claimed', claimId: body.requestId })]),
            );
          if (body.operation === 'tool_result')
            return HttpResponse.json(
              runtimeResponse([
                pendingTool({ status: 'failed', result: body.toolResult as string }),
              ]),
            );
          throw new Error(`Unexpected operation ${String(body.operation)}`);
        }),
        // `otherItem` belongs to a different workspace: the scope guard must refuse locally.
        http.get(`${CORE}/api/v1/items/${otherItem}`, () =>
          HttpResponse.json(
            item({ id: otherItem, workspaceId: '55555555-5555-4555-8555-555555555555' }),
          ),
        ),
      );
      await capture(() =>
        petToolRun(
          'default',
          TOOL,
          { workspace: WORKSPACE, pet: PET, approve: true },
          outputOptions(true, { isTTY: false }),
          { env: profile.env },
        ),
      );
      const resultCall = calls[2];
      expect(resultCall?.body).toMatchObject({
        toolResult: 'The item is outside this workspace. No action was run.',
        toolSuccess: false,
      });
    } finally {
      await profile.done();
    }
  });

  it('rejects resolving a tool call that is no longer pending', async () => {
    const profile = await withProfile();
    try {
      server.use(
        http.post(`${CORE}/api/v1/me/pets/runtime`, () =>
          HttpResponse.json(runtimeResponse([pendingTool({ status: 'completed' })])),
        ),
      );
      await expect(
        petToolRun(
          'default',
          TOOL,
          { workspace: WORKSPACE, pet: PET },
          outputOptions(true, { isTTY: false }),
          { env: profile.env },
        ),
      ).rejects.toThrow(`Tool ${TOOL} is not pending.`);
    } finally {
      await profile.done();
    }
  });

  it('falls back to the unsupported preview when a pending call carries malformed arguments', async () => {
    const profile = await withProfile();
    try {
      server.use(
        http.post(`${CORE}/api/v1/me/pets/runtime`, () =>
          HttpResponse.json(runtimeResponse([pendingTool({ arguments: 'not json' })])),
        ),
      );
      const result = await capture(() =>
        petToolRun(
          'default',
          TOOL,
          { workspace: WORKSPACE, pet: PET },
          outputOptions(true, { isTTY: false }),
          { env: profile.env },
        ),
      );
      expect(result).toMatchObject({
        toolId: TOOL,
        preview:
          'This request is unsupported. Decline it so the companion can try a supported operation.',
      });
    } finally {
      await profile.done();
    }
  });

  it('rejects both --approve and --decline together', async () => {
    const profile = await withProfile();
    try {
      await expect(
        petToolRun(
          'default',
          TOOL,
          { workspace: WORKSPACE, pet: PET, approve: true, decline: true },
          outputOptions(true, { isTTY: false }),
          { env: profile.env },
        ),
      ).rejects.toThrow('Choose either --approve or --decline, not both.');
    } finally {
      await profile.done();
    }
  });
});
