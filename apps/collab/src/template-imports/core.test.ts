import { describe, expect, it } from 'vitest';

import { createCoreTemplateImportClient } from './core.ts';

const IMPORT = '11111111-1111-4111-8111-111111111111';
const JOB = '22222222-2222-4222-8222-222222222222';
const TENANT = '33333333-3333-4333-8333-333333333333';
const PRINCIPAL = '44444444-4444-4444-8444-444444444444';
const WORKSPACE = '55555555-5555-4555-8555-555555555555';
const ITEM = '66666666-6666-4666-8666-666666666666';

describe('the Core worker-fenced template import client', () => {
  it('forwards the exact execution proof and internal secret without a bearer token', async () => {
    let requestedUrl = '';
    let requested: RequestInit | undefined;
    const client = createCoreTemplateImportClient({
      coreBaseUrl: 'https://core.test',
      internalSecret: 'service-secret',
      fetchImpl: (input, init) => {
        requestedUrl =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        requested = init;
        return Promise.resolve(Response.json(authorization()));
      },
    });

    await expect(
      client.authorizeBodies(IMPORT, { jobId: JOB, executionId: 'worker:exact-lease' }),
    ).resolves.toMatchObject({ importId: IMPORT, operationId: null, canWrite: true });

    expect(requestedUrl).toBe(
      `https://core.test/internal/worker-executions/template-imports/${IMPORT}/bodies/authorization`,
    );
    expect(requested?.method).toBe('GET');
    expect(requested?.credentials).toBe('omit');
    expect(requested?.redirect).toBe('error');
    const headers = new Headers(requested?.headers);
    expect(headers.get('x-nix-internal-secret')).toBe('service-secret');
    expect(headers.get('x-nix-worker-job-id')).toBe(JOB);
    expect(headers.get('x-nix-worker-execution-id')).toBe('worker:exact-lease');
    expect(headers.has('authorization')).toBe(false);
  });

  it('refuses a Core URL that could redirect the internal secret through a path or credentials', () => {
    expect(() =>
      createCoreTemplateImportClient({
        coreBaseUrl: 'https://user:secret@core.test/proxy',
        internalSecret: 'service-secret',
      }),
    ).toThrow(/origin without credentials/);
  });

  it('maps a lost execution and Core outages to their retry contracts', async () => {
    const lost = createCoreTemplateImportClient({
      coreBaseUrl: 'https://core.test',
      internalSecret: 'service-secret',
      fetchImpl: () => Promise.resolve(new Response(null, { status: 409 })),
    });
    const unavailable = createCoreTemplateImportClient({
      coreBaseUrl: 'https://core.test',
      internalSecret: 'service-secret',
      fetchImpl: () => Promise.resolve(new Response(null, { status: 500 })),
    });
    const disconnected = createCoreTemplateImportClient({
      coreBaseUrl: 'https://core.test',
      internalSecret: 'service-secret',
      fetchImpl: () => Promise.reject(new Error('connection reset')),
    });

    await expect(
      lost.authorizeBodies(IMPORT, { jobId: JOB, executionId: 'worker:lease' }),
    ).rejects.toMatchObject({ status: 409, code: 'template.execution_lost' });
    await expect(
      unavailable.authorizeBodies(IMPORT, { jobId: JOB, executionId: 'worker:lease' }),
    ).rejects.toMatchObject({ status: 503, code: 'template.core_unavailable' });
    await expect(
      disconnected.authorizeBodies(IMPORT, { jobId: JOB, executionId: 'worker:lease' }),
    ).rejects.toMatchObject({ status: 503, code: 'template.core_unavailable' });
  });

  it('rejects an oversized authorization response before parsing it', async () => {
    const client = createCoreTemplateImportClient({
      coreBaseUrl: 'https://core.test',
      internalSecret: 'service-secret',
      fetchImpl: () =>
        Promise.resolve(
          new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }),
        ),
    });

    await expect(
      client.authorizeBodies(IMPORT, { jobId: JOB, executionId: 'worker:lease' }),
    ).rejects.toMatchObject({ status: 502, code: 'template.authorization_invalid' });
  });
});

function authorization() {
  return {
    tenantId: TENANT,
    principalId: PRINCIPAL,
    workspaceId: WORKSPACE,
    importId: IMPORT,
    operationId: null,
    items: [{ sourceId: 'root', targetItemId: ITEM, itemType: 'note', bodyRequired: true }],
    canWrite: true,
  };
}
