import { describe, expect, it } from 'vitest';

import { createCoreImportClient } from './core.ts';

const IMPORT = '11111111-1111-4111-8111-111111111111';
const JOB = '22222222-2222-4222-8222-222222222222';
const TENANT = '33333333-3333-4333-8333-333333333333';
const PRINCIPAL = '44444444-4444-4444-8444-444444444444';
const WORKSPACE = '55555555-5555-4555-8555-555555555555';
const ITEM = '66666666-6666-4666-8666-666666666666';

describe('the Core staged-import client', () => {
  it('forwards the exact RabbitMQ execution proof without an acting-user bearer token', async () => {
    let requestedUrl = '';
    let requested: RequestInit | undefined;
    const client = createCoreImportClient({
      coreBaseUrl: 'https://core.test',
      internalSecret: 'service-secret',
      fetchImpl: (input, init) => {
        requestedUrl =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        requested = init;
        return Promise.resolve(
          Response.json({
            tenantId: TENANT,
            principalId: PRINCIPAL,
            workspaceId: WORKSPACE,
            importId: IMPORT,
            items: [{ sourceId: 'root', targetItemId: ITEM, itemType: 'note', bodyRequired: true }],
            canWrite: true,
          }),
        );
      },
    });

    await expect(
      client.authorizeBodies(IMPORT, { jobId: JOB, executionId: 'worker:lease' }),
    ).resolves.toMatchObject({ importId: IMPORT, workspaceId: WORKSPACE });

    expect(requestedUrl).toBe(
      `https://core.test/internal/worker-executions/imports/${IMPORT}/bodies/authorization`,
    );
    const headers = new Headers(requested?.headers);
    expect(headers.get('x-nix-internal-secret')).toBe('service-secret');
    expect(headers.get('x-nix-worker-job-id')).toBe(JOB);
    expect(headers.get('x-nix-worker-execution-id')).toBe('worker:lease');
    expect(requested?.credentials).toBe('omit');
    expect(requested?.redirect).toBe('error');
    expect(headers.has('authorization')).toBe(false);
  });

  it('rejects a successful response with duplicate target mappings', async () => {
    const client = createCoreImportClient({
      coreBaseUrl: 'https://core.test',
      internalSecret: 'service-secret',
      fetchImpl: () =>
        Promise.resolve(
          Response.json({
            tenantId: TENANT,
            principalId: PRINCIPAL,
            workspaceId: WORKSPACE,
            importId: IMPORT,
            items: [
              { sourceId: 'one', targetItemId: ITEM, itemType: 'note', bodyRequired: true },
              { sourceId: 'two', targetItemId: ITEM, itemType: 'note', bodyRequired: true },
            ],
            canWrite: true,
          }),
        ),
    });

    await expect(
      client.authorizeBodies(IMPORT, { jobId: JOB, executionId: 'worker:lease' }),
    ).rejects.toMatchObject({ status: 502, code: 'import_authorization_invalid' });
  });

  it('reports Core outages as retryable service failures rather than missing imports', async () => {
    const unavailable = createCoreImportClient({
      coreBaseUrl: 'https://core.test',
      internalSecret: 'service-secret',
      fetchImpl: () => Promise.resolve(new Response(null, { status: 500 })),
    });
    const disconnected = createCoreImportClient({
      coreBaseUrl: 'https://core.test',
      internalSecret: 'service-secret',
      fetchImpl: () => Promise.reject(new Error('connection reset')),
    });

    await expect(
      unavailable.authorizeBodies(IMPORT, { jobId: JOB, executionId: 'worker:lease' }),
    ).rejects.toMatchObject({ status: 503, code: 'import_core_unavailable' });
    await expect(
      disconnected.authorizeBodies(IMPORT, { jobId: JOB, executionId: 'worker:lease' }),
    ).rejects.toMatchObject({ status: 503, code: 'import_core_unavailable' });
  });
});
