import { describe, expect, it, vi } from 'vitest';

import { presignS3, WorkerObjectStore } from './storage.ts';

const NOW = new Date('2026-08-31T12:34:56.000Z');
const OPTIONS = {
  endpoint: 'https://objects.example.test/base',
  region: 'eu-west-2',
  bucket: 'nix-workers',
  accessKey: 'access',
  secretKey: 'secret',
  now: () => NOW,
};

describe('worker object storage', () => {
  it('creates a bounded SigV4 capability without exposing the secret', () => {
    const signed = new URL(
      presignS3({
        ...OPTIONS,
        method: 'PUT',
        key: 'worker-jobs/job/result with space.pdf',
        expiresSeconds: 900,
      }),
    );

    expect(signed.pathname).toBe('/base/nix-workers/worker-jobs/job/result%20with%20space.pdf');
    expect(signed.searchParams.get('X-Amz-Credential')).toBe(
      'access/20260831/eu-west-2/s3/aws4_request',
    );
    expect(signed.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(signed.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.toString()).not.toContain('secret');
  });

  it('stages the authorized stream and removes both transient objects', async () => {
    const calls: { method: string; url: URL; body: string }[] = [];
    const doFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      let body = '';
      if (init?.body !== undefined && init.body !== null) {
        body = await new Response(init.body).text();
      }
      calls.push({
        method: init?.method ?? 'GET',
        url: new URL(input instanceof Request ? input.url : input.toString()),
        body,
      });
      return new Response(null, { status: 200 });
    });
    const store = new WorkerObjectStore({ ...OPTIONS, fetch: doFetch });
    const controller = new AbortController();
    const staged = await store.stageExport(
      {
        manifest: { format: 'nix-archive', items: [], omitted: [] } as never,
        bundles: (async function* () {
          yield await Promise.resolve({ id: 'item', workspaceId: 'workspace' } as never);
        })(),
      },
      'pdf',
      controller.signal,
    );

    expect(staged.workspaceId).toBe('workspace');
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.body).toContain('"workspaceId":"workspace"');
    expect(staged.destinationKey).toMatch(/\/result\.pdf$/);

    await store.remove(staged);
    expect(calls.slice(1).map((call) => call.method)).toEqual(['DELETE', 'DELETE']);
  });
});
