import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { createInMemoryTokenStore } from '../auth.js';
import { createNixClient, type NixClient } from '../client.js';
import { server, TEST_BASE_URL, testUrl } from '../testing/server.js';
import {
  begin,
  beginAndPreviewTemplate,
  byId,
  cancel,
  cancelTemplateImport,
  commit,
  commitAndWaitTemplate,
  preview,
  templateImportKey,
} from './template-imports.js';

const IMPORT_ID = 'a1111111-1111-4111-8111-111111111111';
const PREVIEW_OPERATION_ID = 'a2222222-2222-4222-8222-222222222222';
const COMMIT_OPERATION_ID = 'a3333333-3333-4333-8333-333333333333';
const WORKSPACE_ID = 'a4444444-4444-4444-8444-444444444444';
const TEMPLATE_ID = 'a5555555-5555-4555-8555-555555555555';
const DIGEST = 'a'.repeat(64);
const CAPABILITY = 'http://localhost:9444/template-source';

const input = {
  workspaceId: WORKSPACE_ID,
  fileName: 'weekly-review.nix',
  mediaType: 'application/x-nix-template',
  byteLength: 7,
  idempotencyKey: 'template-import:test',
} as const;

function durableOperation(id: string, kind: string) {
  return {
    id,
    kind,
    status: 'completed',
    result: null,
    errorCode: null,
    errorDetail: null,
    attempts: 1,
    cancellationRequested: false,
    createdAt: '2026-09-01T10:00:00Z',
    completedAt: '2026-09-01T10:00:01Z',
  };
}

function templateImport(
  status: 'preview_queued' | 'preview_ready' | 'commit_queued' | 'staging' | 'staged' | 'completed',
) {
  return {
    id: IMPORT_ID,
    workspaceId: WORKSPACE_ID,
    status,
    previewOperationId: PREVIEW_OPERATION_ID,
    commitOperationId: ['commit_queued', 'staging', 'staged', 'completed'].includes(status)
      ? COMMIT_OPERATION_ID
      : null,
    preview:
      status === 'preview_queued'
        ? null
        : {
            profile: {
              kind: 'template',
              version: 1,
              key: 'weekly-review',
              name: 'Weekly review',
              description: 'A compact weekly review.',
              includeBody: true,
              includeChildren: false,
            },
            digest: DIGEST,
            rootItemType: 'note',
            itemCount: 1,
            bodyCount: 1,
            viewCount: 0,
          },
    result:
      status === 'completed'
        ? {
            operationId: null,
            templateId: TEMPLATE_ID,
            stableKey: 'weekly-review',
            digest: DIGEST,
            unchanged: false,
            writtenTargetItemIds: [],
          }
        : null,
    failureCode: null,
    expiresAt: '2026-09-01T11:00:00Z',
    completedAt: status === 'completed' ? '2026-09-01T10:00:02Z' : null,
  };
}

let client: NixClient;

beforeEach(() => {
  client = createNixClient({
    baseUrl: TEST_BASE_URL,
    tokens: createInMemoryTokenStore({
      initialAccessToken: 'token',
      refresh: () => Promise.resolve(null),
    }),
  });
});

describe('the durable template import resource', () => {
  it('owns every public Core route and stable cache identity', () => {
    expect(begin(input)).toMatchObject({
      path: '/api/v1/template-imports',
      method: 'POST',
      body: input,
    });
    expect(byId(IMPORT_ID)).toMatchObject({
      path: `/api/v1/template-imports/${IMPORT_ID}`,
      cacheKey: templateImportKey(IMPORT_ID),
    });
    expect(preview(IMPORT_ID)).toMatchObject({
      path: `/api/v1/template-imports/${IMPORT_ID}/preview`,
      method: 'POST',
    });
    expect(commit(IMPORT_ID, DIGEST)).toMatchObject({
      path: `/api/v1/template-imports/${IMPORT_ID}/commit`,
      method: 'POST',
      body: { expectedDigest: DIGEST },
    });
    expect(cancel(IMPORT_ID)).toMatchObject({
      path: `/api/v1/template-imports/${IMPORT_ID}`,
      method: 'DELETE',
    });
  });

  it('uploads once through a private capability and waits for a durable preview', async () => {
    let uploaded = '';
    let credentials = '';
    let redirect = '';
    const started: string[] = [];
    server.use(
      http.post(testUrl('/api/v1/template-imports'), () =>
        HttpResponse.json({
          id: IMPORT_ID,
          status: 'pending_upload',
          uploadUrl: CAPABILITY,
          capabilityExpiresAt: '2026-09-01T10:10:00Z',
          expiresAt: '2026-09-01T11:00:00Z',
        }),
      ),
      http.put(CAPABILITY, async ({ request }) => {
        credentials = request.credentials;
        redirect = request.redirect;
        uploaded = await request.text();
        return new HttpResponse(null, { status: 200 });
      }),
      http.post(testUrl(`/api/v1/template-imports/${IMPORT_ID}/preview`), () =>
        HttpResponse.json(durableOperation(PREVIEW_OPERATION_ID, 'template.preview'), {
          status: 202,
        }),
      ),
      http.get(testUrl(`/api/v1/operations/${PREVIEW_OPERATION_ID}`), () =>
        HttpResponse.json(durableOperation(PREVIEW_OPERATION_ID, 'template.preview')),
      ),
      http.get(testUrl(`/api/v1/template-imports/${IMPORT_ID}`), () =>
        HttpResponse.json(templateImport('preview_ready')),
      ),
    );

    const result = await beginAndPreviewTemplate(
      client,
      input,
      new Blob(['archive'], { type: input.mediaType }),
      undefined,
      (id) => started.push(id),
    );

    expect(uploaded).toBe('archive');
    expect(credentials).toBe('omit');
    expect(redirect).toBe('error');
    expect(started).toEqual([IMPORT_ID]);
    expect(result.preview?.digest).toBe(DIGEST);
  });

  it('recovers an existing durable preview without uploading the source again', async () => {
    let previewRequests = 0;
    server.use(
      http.post(testUrl('/api/v1/template-imports'), () =>
        HttpResponse.json({
          id: IMPORT_ID,
          status: 'preview_ready',
          uploadUrl: null,
          capabilityExpiresAt: null,
          expiresAt: '2026-09-01T11:00:00Z',
        }),
      ),
      http.post(testUrl(`/api/v1/template-imports/${IMPORT_ID}/preview`), () => {
        previewRequests += 1;
        return HttpResponse.json(durableOperation(PREVIEW_OPERATION_ID, 'template.preview'));
      }),
      http.get(testUrl(`/api/v1/template-imports/${IMPORT_ID}`), () =>
        HttpResponse.json(templateImport('preview_ready')),
      ),
    );

    const result = await beginAndPreviewTemplate(
      client,
      input,
      new Blob(['archive'], { type: input.mediaType }),
    );

    expect(result.status).toBe('preview_ready');
    expect(previewRequests).toBe(0);
  });

  it('waits for an existing queued preview without uploading or queueing it again', async () => {
    let importReads = 0;
    let operationReads = 0;
    let previewRequests = 0;
    server.use(
      http.post(testUrl('/api/v1/template-imports'), () =>
        HttpResponse.json({
          id: IMPORT_ID,
          status: 'preview_queued',
          uploadUrl: null,
          capabilityExpiresAt: null,
          expiresAt: '2026-09-01T11:00:00Z',
        }),
      ),
      http.post(testUrl(`/api/v1/template-imports/${IMPORT_ID}/preview`), () => {
        previewRequests += 1;
        return HttpResponse.json(durableOperation(PREVIEW_OPERATION_ID, 'template.preview'));
      }),
      http.get(testUrl(`/api/v1/operations/${PREVIEW_OPERATION_ID}`), () => {
        operationReads += 1;
        return HttpResponse.json(durableOperation(PREVIEW_OPERATION_ID, 'template.preview'));
      }),
      http.get(testUrl(`/api/v1/template-imports/${IMPORT_ID}`), () => {
        importReads += 1;
        return HttpResponse.json(
          templateImport(importReads === 1 ? 'preview_queued' : 'preview_ready'),
        );
      }),
    );

    const result = await beginAndPreviewTemplate(
      client,
      input,
      new Blob(['archive'], { type: input.mediaType }),
    );

    expect(result.status).toBe('preview_ready');
    expect(importReads).toBe(2);
    expect(operationReads).toBe(1);
    expect(previewRequests).toBe(0);
  });

  it('recovers a ready preview when polling briefly loses the accepted operation', async () => {
    let importReads = 0;
    server.use(
      http.post(testUrl('/api/v1/template-imports'), () =>
        HttpResponse.json({
          id: IMPORT_ID,
          status: 'preview_queued',
          uploadUrl: null,
          capabilityExpiresAt: null,
          expiresAt: '2026-09-01T11:00:00Z',
        }),
      ),
      http.get(testUrl(`/api/v1/operations/${PREVIEW_OPERATION_ID}`), () => HttpResponse.error()),
      http.get(testUrl(`/api/v1/template-imports/${IMPORT_ID}`), () => {
        importReads += 1;
        return HttpResponse.json(
          templateImport(importReads === 1 ? 'preview_queued' : 'preview_ready'),
        );
      }),
    );

    const result = await beginAndPreviewTemplate(
      client,
      input,
      new Blob(['archive'], { type: input.mediaType }),
    );

    expect(result.status).toBe('preview_ready');
    expect(importReads).toBe(2);
  });

  it('leaves a durable preview resumable when its caller stops waiting', async () => {
    const controller = new AbortController();
    let cancellations = 0;
    server.use(
      http.post(testUrl('/api/v1/template-imports'), () =>
        HttpResponse.json({
          id: IMPORT_ID,
          status: 'preview_queued',
          uploadUrl: null,
          capabilityExpiresAt: null,
          expiresAt: '2026-09-01T11:00:00Z',
        }),
      ),
      http.get(testUrl(`/api/v1/template-imports/${IMPORT_ID}`), () =>
        HttpResponse.json(templateImport('preview_queued')),
      ),
      http.get(testUrl(`/api/v1/operations/${PREVIEW_OPERATION_ID}`), () => {
        controller.abort();
        return HttpResponse.json({
          ...durableOperation(PREVIEW_OPERATION_ID, 'template.preview'),
          status: 'running',
          completedAt: null,
        });
      }),
      http.delete(testUrl(`/api/v1/template-imports/${IMPORT_ID}`), () => {
        cancellations += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await expect(
      beginAndPreviewTemplate(
        client,
        input,
        new Blob(['archive'], { type: input.mediaType }),
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(cancellations).toBe(0);
  });

  it('commits by digest without receiving or uploading the archive again', async () => {
    let commitBody: unknown;
    server.use(
      http.post(testUrl(`/api/v1/template-imports/${IMPORT_ID}/commit`), async ({ request }) => {
        commitBody = await request.json();
        return HttpResponse.json(durableOperation(COMMIT_OPERATION_ID, 'template.commit'), {
          status: 202,
        });
      }),
      http.get(testUrl(`/api/v1/operations/${COMMIT_OPERATION_ID}`), () =>
        HttpResponse.json(durableOperation(COMMIT_OPERATION_ID, 'template.commit')),
      ),
      http.get(testUrl(`/api/v1/template-imports/${IMPORT_ID}`), () =>
        HttpResponse.json(templateImport('completed')),
      ),
    );

    const result = await commitAndWaitTemplate(client, IMPORT_ID, DIGEST);

    expect(commitBody).toEqual({ expectedDigest: DIGEST });
    expect(result.result?.templateId).toBe(TEMPLATE_ID);
  });

  it('recovers a completed import when the commit response is lost', async () => {
    server.use(
      http.post(testUrl(`/api/v1/template-imports/${IMPORT_ID}/commit`), () =>
        HttpResponse.error(),
      ),
      http.get(testUrl(`/api/v1/template-imports/${IMPORT_ID}`), () =>
        HttpResponse.json(templateImport('completed')),
      ),
    );

    const result = await commitAndWaitTemplate(client, IMPORT_ID, DIGEST);

    expect(result.status).toBe('completed');
    expect(result.result?.digest).toBe(DIGEST);
  });

  it('continues the accepted commit when its enqueue response is lost', async () => {
    let importReads = 0;
    let operationReads = 0;
    server.use(
      http.post(testUrl(`/api/v1/template-imports/${IMPORT_ID}/commit`), () =>
        HttpResponse.error(),
      ),
      http.get(testUrl(`/api/v1/operations/${COMMIT_OPERATION_ID}`), () => {
        operationReads += 1;
        return HttpResponse.json(durableOperation(COMMIT_OPERATION_ID, 'template.commit'));
      }),
      http.get(testUrl(`/api/v1/template-imports/${IMPORT_ID}`), () => {
        importReads += 1;
        return HttpResponse.json(templateImport(importReads === 1 ? 'commit_queued' : 'completed'));
      }),
    );

    const result = await commitAndWaitTemplate(client, IMPORT_ID, DIGEST);

    expect(result.status).toBe('completed');
    expect(importReads).toBe(2);
    expect(operationReads).toBe(1);
  });

  it('refuses an unsafe capability while leaving the durable attempt recoverable', async () => {
    let cancellations = 0;
    server.use(
      http.post(testUrl('/api/v1/template-imports'), () =>
        HttpResponse.json({
          id: IMPORT_ID,
          status: 'pending_upload',
          uploadUrl: 'http://objects.example/template.nix',
          capabilityExpiresAt: '2026-09-01T10:10:00Z',
          expiresAt: '2026-09-01T11:00:00Z',
        }),
      ),
      http.get(testUrl(`/api/v1/template-imports/${IMPORT_ID}`), () =>
        HttpResponse.json({
          ...templateImport('preview_ready'),
          status: 'pending_upload',
          previewOperationId: null,
          preview: null,
        }),
      ),
      http.delete(testUrl(`/api/v1/template-imports/${IMPORT_ID}`), () => {
        cancellations += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await expect(
      beginAndPreviewTemplate(client, input, new Blob(['archive'], { type: input.mediaType })),
    ).rejects.toThrow(/HTTPS/);
    expect(cancellations).toBe(0);
  });

  it('refuses capability URL credentials without silently cancelling the durable attempt', async () => {
    let cancellations = 0;
    server.use(
      http.post(testUrl('/api/v1/template-imports'), () =>
        HttpResponse.json({
          id: IMPORT_ID,
          status: 'pending_upload',
          uploadUrl: 'https://user:password@objects.example/template.nix',
          capabilityExpiresAt: '2026-09-01T10:10:00Z',
          expiresAt: '2026-09-01T11:00:00Z',
        }),
      ),
      http.get(testUrl(`/api/v1/template-imports/${IMPORT_ID}`), () =>
        HttpResponse.json({
          ...templateImport('preview_ready'),
          status: 'pending_upload',
          previewOperationId: null,
          preview: null,
        }),
      ),
      http.delete(testUrl(`/api/v1/template-imports/${IMPORT_ID}`), () => {
        cancellations += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await expect(
      beginAndPreviewTemplate(client, input, new Blob(['archive'], { type: input.mediaType })),
    ).rejects.toThrow(/credentials/);
    expect(cancellations).toBe(0);
  });

  it('offers an explicit cancellation helper', async () => {
    let cancellations = 0;
    server.use(
      http.delete(testUrl(`/api/v1/template-imports/${IMPORT_ID}`), () => {
        cancellations += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await cancelTemplateImport(client, IMPORT_ID);

    expect(cancellations).toBe(1);
  });
});
