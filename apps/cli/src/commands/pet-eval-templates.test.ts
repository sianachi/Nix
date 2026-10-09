import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { templateSummarySchema, type TemplateSummary } from '@nix/api-client';
import { openSession } from '../session.ts';
import {
  registerEvalTemplate,
  removeEvalTemplates,
  seedEvalTemplate,
} from './pet-eval-templates.ts';

const CORE = 'http://core.eval.test';
const COLLAB = 'http://collab.eval.test';
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const SOURCE = '22222222-2222-4222-8222-222222222222';
const TEMPLATE = '33333333-3333-4333-8333-333333333333';
const OPERATION = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const TEMPLATE_SOURCE = '66666666-6666-4666-8666-666666666666';
const FINGERPRINT = 'a'.repeat(64);
const CAPTURE_FINGERPRINT = 'b'.repeat(64);

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

function session() {
  return openSession({
    profile: { apiUrl: CORE, collabUrl: COLLAB, token: 'unused-test-pat' },
    bearerToken: 'eval-test-session',
  });
}

function source(overrides: Record<string, unknown> = {}) {
  return {
    id: SOURCE,
    workspaceId: WORKSPACE,
    parentId: OTHER,
    type: 'note',
    title: 'Planning meeting',
    hasChildren: false,
    seq: '1000',
    lifecycleState: 'active',
    properties: { title: 'Planning meeting' },
    createdAt: '2026-10-09T10:00:00Z',
    updatedAt: '2026-10-09T10:00:00Z',
    ...overrides,
  };
}

function detail(overrides: Record<string, unknown> = {}) {
  return {
    id: TEMPLATE,
    workspaceId: WORKSPACE,
    title: 'Nix eval meeting template',
    description: null,
    origin: 'user',
    revision: 1,
    includeBody: true,
    includeChildren: false,
    fieldCount: 0,
    viewCount: 0,
    childCount: 0,
    viewKinds: [],
    capabilities: { canEdit: true, canDelete: true, canExport: true, canApply: true },
    updatedAt: '2026-10-09T10:00:00Z',
    initialization: { version: 1, inputs: [], rules: [], references: [] },
    root: {
      sourceId: TEMPLATE_SOURCE,
      itemType: 'note',
      title: 'Planning meeting',
      seq: '1000',
      properties: { title: 'Planning meeting' },
      schema: { properties: [], inherit: false },
      views: null,
      hasBody: true,
      recurrence: null,
      children: [],
    },
    ...overrides,
  };
}

function preview(overrides: Record<string, unknown> = {}) {
  return {
    fingerprint: FINGERPRINT,
    captureFingerprint: CAPTURE_FINGERPRINT,
    sourceTitle: 'Planning meeting',
    itemCount: 1,
    ...overrides,
  };
}

function captureResult(overrides: Record<string, unknown> = {}) {
  return {
    templateId: TEMPLATE,
    operationId: OPERATION,
    writtenTargetItemIds: [],
    ...overrides,
  };
}

function seedEndpoints(
  options: {
    source?: Record<string, unknown>;
    children?: Record<string, unknown>[];
    preview?: Record<string, unknown>;
    capture?: Record<string, unknown>;
    detail?: Record<string, unknown>;
  } = {},
) {
  const calls: string[] = [];
  let requestBody: Record<string, unknown> | undefined;
  server.use(
    http.get(`${CORE}/api/v1/items/${SOURCE}`, () => {
      calls.push('source');
      return HttpResponse.json(options.source ?? source());
    }),
    http.get(`${CORE}/api/v1/workspaces/${WORKSPACE}/items`, ({ request }) => {
      calls.push('children');
      const url = new URL(request.url);
      expect(url.searchParams.get('parentId')).toBe(SOURCE);
      expect(url.searchParams.get('limit')).toBe('1');
      expect(url.searchParams.has('cursor')).toBe(false);
      return HttpResponse.json({ items: options.children ?? [], nextCursor: null });
    }),
    http.get(
      `${CORE}/api/v1/workspaces/${WORKSPACE}/templates/capture-preview/${SOURCE}`,
      ({ request }) => {
        calls.push('preview');
        expect(new URL(request.url).searchParams.get('includeChildren')).toBe('false');
        return HttpResponse.json(options.preview ?? preview());
      },
    ),
    http.post(`${COLLAB}/templates/captures`, async ({ request }) => {
      calls.push('capture');
      expect(request.headers.get('authorization')).toBe('Bearer eval-test-session');
      requestBody = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json(options.capture ?? captureResult());
    }),
    http.get(`${CORE}/api/v1/templates/${TEMPLATE}`, () => {
      calls.push('detail');
      return HttpResponse.json(options.detail ?? detail());
    }),
  );
  return {
    calls,
    get requestBody() {
      return requestBody;
    },
  };
}

describe('fixture-owned eval templates', () => {
  it('captures exactly one fixture note through Collab with the Core preview fence', async () => {
    const endpoints = seedEndpoints();
    const owned = new Map<string, TemplateSummary>();
    await seedEvalTemplate(session(), WORKSPACE, SOURCE, owned);
    expect(endpoints.calls).toEqual(['source', 'children', 'preview', 'capture', 'detail']);
    expect(endpoints.requestBody).toEqual({
      workspaceId: WORKSPACE,
      sourceItemId: SOURCE,
      title: 'Nix eval meeting template',
      includeBody: true,
      includeChildren: false,
      idempotencyKey: endpoints.requestBody?.idempotencyKey,
      expectedFingerprint: CAPTURE_FINGERPRINT,
    });
    expect(endpoints.requestBody?.idempotencyKey).toMatch(/^eval-template-[a-f0-9-]{36}$/);
    expect(owned.get(TEMPLATE)).toEqual(templateSummarySchema.parse(detail()));
    expect(owned.get(TEMPLATE)).not.toHaveProperty('root');
  });

  it.each([
    { id: OTHER },
    { workspaceId: OTHER },
    { lifecycleState: 'deleted' },
    { type: 'file' },
    { hasChildren: true },
    { properties: { title: 'Planning meeting', attachment: OTHER } },
  ])('rejects an unsafe source before capture: %j', async (change) => {
    const endpoints = seedEndpoints({ source: source(change) });
    const owned = new Map<string, TemplateSummary>();
    await expect(seedEvalTemplate(session(), WORKSPACE, SOURCE, owned)).rejects.toThrow(
      'synthetic note leaf',
    );
    expect(endpoints.calls).toEqual(['source']);
    expect(owned.size).toBe(0);
  });

  it('checks bounded direct children even when hasChildren is stale', async () => {
    const endpoints = seedEndpoints({ children: [source({ id: OTHER, parentId: SOURCE })] });
    await expect(seedEvalTemplate(session(), WORKSPACE, SOURCE, new Map())).rejects.toThrow(
      'no children',
    );
    expect(endpoints.calls).toEqual(['source', 'children']);
  });

  it.each([{ itemCount: 0 }, { itemCount: 2 }, { sourceTitle: 'Changed source' }])(
    'refuses a mismatched preview before capture: %j',
    async (change) => {
      const endpoints = seedEndpoints({ preview: preview(change) });
      await expect(seedEvalTemplate(session(), WORKSPACE, SOURCE, new Map())).rejects.toThrow(
        'exactly the source note',
      );
      expect(endpoints.calls).toEqual(['source', 'children', 'preview']);
    },
  );

  it('records ownership before a failing detail query and can clean up that capture', async () => {
    const endpoints = seedEndpoints();
    const owned = new Map<string, TemplateSummary>();
    server.use(
      http.get(`${CORE}/api/v1/templates/${TEMPLATE}`, () => {
        expect(owned.get(TEMPLATE)?.capabilities.canApply).toBe(false);
        return HttpResponse.json({ code: 'template.read_failed', status: 503 }, { status: 503 });
      }),
      http.delete(
        `${CORE}/api/v1/templates/${TEMPLATE}`,
        () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const active = session();
    await expect(seedEvalTemplate(active, WORKSPACE, SOURCE, owned)).rejects.toMatchObject({
      status: 503,
    });
    expect(endpoints.calls).toContain('capture');
    expect(owned.has(TEMPLATE)).toBe(true);
    await removeEvalTemplates(active, owned);
    expect(owned.size).toBe(0);
  });

  it.each([
    { fileTransferPending: true },
    { fileTransferJobId: OPERATION, fileTransferPending: false },
  ])('retains capture ownership without resuming a transfer: %j', async (change) => {
    const endpoints = seedEndpoints({ capture: captureResult(change) });
    const owned = new Map<string, TemplateSummary>();
    await expect(seedEvalTemplate(session(), WORKSPACE, SOURCE, owned)).rejects.toThrow(
      'file transfer',
    );
    expect(owned.get(TEMPLATE)?.capabilities.canApply).toBe(false);
    expect(endpoints.calls).toEqual(['source', 'children', 'preview', 'capture']);
  });

  it('keeps ownership when a captured note title is changed unexpectedly', async () => {
    seedEndpoints({ detail: detail({ root: { ...detail().root, title: 'Different note' } }) });
    const owned = new Map<string, TemplateSummary>();
    await expect(seedEvalTemplate(session(), WORKSPACE, SOURCE, owned)).rejects.toThrow(
      'source note title',
    );
    expect(owned.get(TEMPLATE)?.capabilities.canApply).toBe(false);
  });

  it('does not invent cleanup ownership when capture returns no usable receipt', async () => {
    const endpoints = seedEndpoints();
    const owned = new Map<string, TemplateSummary>();
    server.use(
      http.post(`${COLLAB}/templates/captures`, () => {
        return HttpResponse.json({ code: 'capture.failed', status: 503 }, { status: 503 });
      }),
    );
    await expect(seedEvalTemplate(session(), WORKSPACE, SOURCE, owned)).rejects.toMatchObject({
      status: 503,
    });
    expect(endpoints.calls).toEqual(['source', 'children', 'preview']);
    expect(owned.size).toBe(0);
  });

  it('registers a trusted pet capture with its actual title and remapped source ID', async () => {
    const saved = detail({ title: 'Nix eval saved meeting template', includeChildren: true });
    server.use(http.get(`${CORE}/api/v1/templates/${TEMPLATE}`, () => HttpResponse.json(saved)));
    const owned = new Map<string, TemplateSummary>();
    await registerEvalTemplate(session(), WORKSPACE, TEMPLATE, owned);
    expect(owned.get(TEMPLATE)).toEqual(templateSummarySchema.parse(saved));
  });

  it.each([
    { id: OTHER },
    { workspaceId: OTHER },
    { origin: 'seed' },
    { origin: 'managed' },
    { includeBody: false },
    { childCount: 1 },
    { fieldCount: 1 },
    { viewCount: 1 },
    { root: { ...detail().root, itemType: 'file' } },
    { root: { ...detail().root, hasBody: false } },
    { root: { ...detail().root, properties: { attachment: OTHER } } },
    { root: { ...detail().root, children: [detail().root] } },
    { root: { ...detail().root, recurrence: {} } },
    {
      root: {
        ...detail().root,
        schema: {
          properties: [{ key: 'attachment', label: 'Attachment', type: 'file', required: false }],
          inherit: false,
        },
      },
    },
    {
      root: {
        ...detail().root,
        schema: {
          properties: [],
          declared: [{ key: 'attachment', label: 'Attachment', type: 'file', required: false }],
          inherit: false,
        },
      },
    },
    {
      initialization: {
        version: 1,
        inputs: [{ key: 'name', label: 'Name', type: 'text', required: false }],
        rules: [],
        references: [],
      },
    },
    {
      initialization: {
        version: 1,
        inputs: [],
        rules: [],
        references: [{ sourceItemId: OTHER, policy: 'retain' }],
      },
    },
    {
      initialization: {
        version: 1,
        inputs: [],
        rules: [{ sourceId: TEMPLATE_SOURCE, propertyKey: 'title', kind: 'clear' }],
        references: [],
      },
    },
  ])('fails verification without losing cleanup ownership: %j', async (change) => {
    server.use(
      http.get(`${CORE}/api/v1/templates/${TEMPLATE}`, () => HttpResponse.json(detail(change))),
    );
    const owned = new Map<string, TemplateSummary>();
    await expect(registerEvalTemplate(session(), WORKSPACE, TEMPLATE, owned)).rejects.toThrow(
      'one plain note',
    );
    expect(owned.get(TEMPLATE)?.capabilities.canApply).toBe(false);
  });

  it('rejects invalid IDs before requests or cleanup ownership are created', async () => {
    const owned = new Map<string, TemplateSummary>();
    await expect(registerEvalTemplate(session(), WORKSPACE, '../other', owned)).rejects.toThrow();
    await expect(seedEvalTemplate(session(), '../other', SOURCE, owned)).rejects.toThrow();
    expect(owned.size).toBe(0);
  });

  it('removes only registered IDs without enumerating the library', async () => {
    const owned = new Map([[TEMPLATE, templateSummarySchema.parse(detail())]]);
    const deleted: string[] = [];
    server.use(
      http.delete(`${CORE}/api/v1/templates/:id`, ({ params }) => {
        deleted.push(String(params.id));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await removeEvalTemplates(session(), owned);
    expect(deleted).toEqual([TEMPLATE]);
    expect(owned.size).toBe(0);
  });

  it('tries remaining owned captures after deletion fails, retaining failures for recovery', async () => {
    const owned = new Map([
      [TEMPLATE, templateSummarySchema.parse(detail())],
      [OTHER, templateSummarySchema.parse(detail({ id: OTHER }))],
    ]);
    const deleted: string[] = [];
    server.use(
      http.delete(`${CORE}/api/v1/templates/:id`, ({ params }) => {
        deleted.push(String(params.id));
        return params.id === TEMPLATE
          ? HttpResponse.json({ code: 'template.delete_failed', status: 503 }, { status: 503 })
          : new HttpResponse(null, { status: 204 });
      }),
    );
    await expect(removeEvalTemplates(session(), owned)).rejects.toThrow(AggregateError);
    expect(deleted).toEqual([TEMPLATE, OTHER]);
    expect([...owned.keys()]).toEqual([TEMPLATE]);
  });

  it('refuses a mismatched registry identity without deleting anything', async () => {
    const owned = new Map([[OTHER, templateSummarySchema.parse(detail())]]);
    await expect(removeEvalTemplates(session(), owned)).rejects.toThrow(AggregateError);
    expect(owned.has(OTHER)).toBe(true);
  });

  it('validates cleanup IDs at the API boundary before deletion', async () => {
    const invalid = { ...templateSummarySchema.parse(detail()), id: '../other' };
    const owned = new Map([[invalid.id, invalid]]);
    await expect(removeEvalTemplates(session(), owned)).rejects.toThrow(AggregateError);
    expect(owned.has(invalid.id)).toBe(true);
  });
});
