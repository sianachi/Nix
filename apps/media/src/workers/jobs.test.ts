import { describe, expect, it, vi } from 'vitest';
import { createWorkerJobs } from './jobs.ts';

describe('Go worker jobs', () => {
  it('forwards both service and acting-user credentials', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'job',
          kind: 'export.pdf',
          status: 'queued',
          result: null,
          errorCode: null,
          errorDetail: null,
        }),
        { status: 200 },
      ),
    );
    const jobs = createWorkerJobs({
      coreBaseUrl: 'https://core.test',
      internalSecret: 'secret',
      fetch,
    });
    await jobs.createExport(
      'user-token',
      {
        workspaceId: 'workspace',
        format: 'pdf',
        sourceUrl: 'https://store/source',
        destinationUrl: 'https://store/output',
        idempotencyKey: 'key',
      },
      new AbortController().signal,
    );
    const call = fetch.mock.calls.at(0);
    expect(call?.[0]).toBe('https://core.test/internal/worker/jobs/exports');
    const headers = new Headers(call?.[1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer user-token');
    expect(headers.get('x-nix-internal-secret')).toBe('secret');
  });

  it('creates an import preview with the forwarded user identity', async () => {
    const doFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 'job-2', kind: 'import.nix', status: 'queued' })),
      );
    const jobs = createWorkerJobs({
      coreBaseUrl: 'https://core.test',
      internalSecret: 'internal',
      fetch: doFetch,
    });

    await jobs.createImport(
      'user-token',
      {
        workspaceId: 'workspace',
        format: 'nix',
        sourceUrl: 'https://objects.test/source',
        rootId: 'root',
        title: 'Imported document',
        idempotencyKey: 'import:key',
        preview: true,
      },
      new AbortController().signal,
    );

    const call = doFetch.mock.calls[0];
    expect(call?.[0]).toBe('https://core.test/internal/worker/jobs/imports');
    expect(new Headers(call?.[1]?.headers).get('authorization')).toBe('Bearer user-token');
  });
});
