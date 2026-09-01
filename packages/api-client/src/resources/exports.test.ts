import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createInMemoryTokenStore } from '../auth.js';
import { createNixClient, type NixClient } from '../client.js';
import type { Export } from '../schemas/exports.js';
import { server, TEST_BASE_URL, testUrl } from '../testing/server.js';
import {
  authorizeDownload,
  begin,
  beginAndWait,
  byId,
  cancel,
  downloadCapability,
  downloadForCompletedExport,
  formats,
} from './exports.js';

const EXPORT_ID = 'a1111111-1111-4111-8111-111111111111';
const ITEM_ID = 'a2222222-2222-4222-8222-222222222222';
const WORKSPACE_ID = 'a3333333-3333-4333-8333-333333333333';

function exportState(status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'): Export {
  const completed = status === 'completed';
  return {
    id: EXPORT_ID,
    itemId: ITEM_ID,
    workspaceId: WORKSPACE_ID,
    format: 'nix',
    scope: 'subtree',
    fileName: 'notes.nix',
    mediaType: 'application/vnd.nix.archive+zip',
    status,
    itemCount: completed ? 3 : null,
    omittedCount: completed ? 0 : null,
    byteLength: completed ? 128 : null,
    sha256: completed ? 'a'.repeat(64) : null,
    loss: [],
    omissions: [],
    failureCode: status === 'failed' ? 'export.failed' : null,
    failureDetail: status === 'failed' ? 'The worker could not write the archive.' : null,
    cancellationRequested: false,
    downloadReady: completed,
    createdAt: '2026-09-01T09:00:00+00:00',
    completedAt: completed ? '2026-09-01T09:00:02+00:00' : null,
    expiresAt: completed ? '2026-09-02T09:00:02+00:00' : null,
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

describe('the exports resource', () => {
  it('keeps every durable export operation behind Core', () => {
    expect(formats()).toMatchObject({
      path: '/api/v1/exports/formats',
      cacheKey: ['exports', 'formats'],
    });
    expect(
      begin({
        itemId: ITEM_ID,
        format: 'nix',
        scope: 'subtree',
        idempotencyKey: 'web-export:one',
      }),
    ).toMatchObject({ path: '/api/v1/exports', method: 'POST' });
    expect(byId(EXPORT_ID)).toMatchObject({ path: `/api/v1/exports/${EXPORT_ID}` });
    expect(cancel(EXPORT_ID)).toMatchObject({
      path: `/api/v1/exports/${EXPORT_ID}/cancel`,
      method: 'POST',
    });
    expect(authorizeDownload(EXPORT_ID)).toMatchObject({
      path: `/api/v1/exports/${EXPORT_ID}/download`,
    });
  });

  it('starts a job, reports progress, and obtains a private download capability', async () => {
    let polls = 0;
    let receivedBody: unknown;
    const progress: string[] = [];
    server.use(
      http.post(testUrl('/api/v1/exports'), async ({ request }) => {
        receivedBody = await request.json();
        return HttpResponse.json(exportState('queued'), { status: 202 });
      }),
      http.get(testUrl(`/api/v1/exports/${EXPORT_ID}`), () => {
        polls += 1;
        return HttpResponse.json(exportState(polls === 1 ? 'running' : 'completed'));
      }),
      http.get(testUrl(`/api/v1/exports/${EXPORT_ID}/download`), () =>
        HttpResponse.json({
          url: 'https://objects.example/private/result.nix?signature=secret',
          expiresAt: '2999-09-01T09:10:00+00:00',
          fileName: 'notes.nix',
          mediaType: 'application/vnd.nix.archive+zip',
          byteLength: 128,
          sha256: 'a'.repeat(64),
        }),
      ),
    );

    const completed = await beginAndWait(
      client,
      {
        itemId: ITEM_ID,
        format: 'nix',
        scope: 'subtree',
        idempotencyKey: 'web-export:one',
      },
      { pollIntervalMs: 10, onProgress: (state) => progress.push(state.status) },
    );
    const capability = await downloadForCompletedExport(client, completed);

    expect(receivedBody).toEqual({
      itemId: ITEM_ID,
      format: 'nix',
      scope: 'subtree',
      idempotencyKey: 'web-export:one',
    });
    expect(progress).toEqual(['queued', 'running', 'completed']);
    expect(capability.fileName).toBe('notes.nix');
    expect(capability.url).toContain('signature=secret');
  });

  it('returns a failed terminal job so the caller can show its durable failure detail', async () => {
    server.use(
      http.post(testUrl('/api/v1/exports'), () =>
        HttpResponse.json(exportState('queued'), { status: 202 }),
      ),
      http.get(testUrl(`/api/v1/exports/${EXPORT_ID}`), () =>
        HttpResponse.json(exportState('failed')),
      ),
    );

    const failed = await beginAndWait(
      client,
      {
        itemId: ITEM_ID,
        format: 'nix',
        scope: 'item',
        idempotencyKey: 'web-export:failed',
      },
      { pollIntervalMs: 10 },
    );

    expect(failed).toMatchObject({
      status: 'failed',
      failureCode: 'export.failed',
      failureDetail: 'The worker could not write the archive.',
    });
  });

  it('refuses an unsafe capability without navigating to it', async () => {
    server.use(
      http.get(testUrl(`/api/v1/exports/${EXPORT_ID}/download`), () =>
        HttpResponse.json({
          url: 'http://objects.example/result.nix',
          expiresAt: '2999-09-01T09:10:00+00:00',
          fileName: 'notes.nix',
          mediaType: 'application/vnd.nix.archive+zip',
          byteLength: 128,
          sha256: 'a'.repeat(64),
        }),
      ),
    );

    await expect(downloadCapability(client, EXPORT_ID)).rejects.toThrow(/HTTPS/);
  });

  it('refuses capability metadata that does not match the completed job', async () => {
    server.use(
      http.get(testUrl(`/api/v1/exports/${EXPORT_ID}/download`), () =>
        HttpResponse.json({
          url: 'https://objects.example/result.nix',
          expiresAt: '2999-09-01T09:10:00+00:00',
          fileName: 'notes.nix',
          mediaType: 'application/vnd.nix.archive+zip',
          byteLength: 128,
          sha256: 'b'.repeat(64),
        }),
      ),
    );

    await expect(downloadForCompletedExport(client, exportState('completed'))).rejects.toThrow(
      /did not match/,
    );
  });

  it('cancels polling when its caller leaves', async () => {
    const controller = new AbortController();
    const query = vi.spyOn(client, 'query');
    server.use(
      http.post(testUrl('/api/v1/exports'), () =>
        HttpResponse.json(exportState('queued'), { status: 202 }),
      ),
    );
    const waiting = beginAndWait(
      client,
      {
        itemId: ITEM_ID,
        format: 'nix',
        scope: 'item',
        idempotencyKey: 'web-export:cancelled',
      },
      {
        signal: controller.signal,
        pollIntervalMs: 100,
        onStarted: () => {
          controller.abort(new DOMException('cancelled', 'AbortError'));
        },
      },
    );

    await expect(waiting).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});
