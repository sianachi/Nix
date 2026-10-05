import { describe, expect, it } from 'vitest';

import { createCoreTranscriptionClient } from './core.ts';

const JOB = '22222222-2222-4222-8222-222222222222';
const TENANT = '33333333-3333-4333-8333-333333333333';
const PRINCIPAL = '44444444-4444-4444-8444-444444444444';
const WORKSPACE = '55555555-5555-4555-8555-555555555555';
const NOTE = '66666666-6666-4666-8666-666666666666';
const AUDIO = '77777777-7777-4777-8777-777777777777';

const GRANT = {
  tenantId: TENANT,
  principalId: PRINCIPAL,
  workspaceId: WORKSPACE,
  noteItemId: NOTE,
  audioItemId: AUDIO,
  audioTitle: 'Planning call',
  canWrite: true,
};

function clientAnswering(respond: () => Promise<Response>) {
  return createCoreTranscriptionClient({
    coreBaseUrl: 'https://core.test',
    internalSecret: 'service-secret',
    fetchImpl: respond,
  });
}

const EXECUTION = { jobId: JOB, executionId: 'worker:lease' };

describe('the Core transcription client', () => {
  it('asks by execution alone, with the service secret and no acting-user token', async () => {
    let requestedUrl = '';
    let requested: RequestInit | undefined;
    const client = createCoreTranscriptionClient({
      coreBaseUrl: 'https://core.test',
      internalSecret: 'service-secret',
      fetchImpl: (input, init) => {
        requestedUrl =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        requested = init;
        return Promise.resolve(Response.json({ ...GRANT, somethingNew: 1 }));
      },
    });

    await expect(client.authorize(EXECUTION)).resolves.toEqual(GRANT);

    expect(requestedUrl).toBe(
      'https://core.test/internal/worker-executions/transcriptions/authorization',
    );
    expect(requested?.method).toBeUndefined();
    const headers = new Headers(requested?.headers);
    expect(headers.get('x-nix-internal-secret')).toBe('service-secret');
    expect(headers.get('x-nix-worker-job-id')).toBe(JOB);
    expect(headers.get('x-nix-worker-execution-id')).toBe('worker:lease');
    expect(headers.has('authorization')).toBe(false);
    expect(requested?.credentials).toBe('omit');
    expect(requested?.redirect).toBe('error');
  });

  it('maps a failed fetch and a Core fault to a retryable refusal', async () => {
    const hangUp = new Error('socket hang up');
    await expect(
      clientAnswering(() => Promise.reject(hangUp)).authorize(EXECUTION),
    ).rejects.toMatchObject({
      status: 503,
      code: 'transcription_core_unavailable',
      // Kept for the operator log; the message the worker sees does not carry it.
      cause: hangUp,
      message: 'Core could not authorize this transcription.',
    });
    await expect(
      clientAnswering(() => Promise.resolve(new Response(null, { status: 502 }))).authorize(
        EXECUTION,
      ),
    ).rejects.toMatchObject({ status: 503, code: 'transcription_core_unavailable' });
  });

  it('maps a lost lease, a missing job and any other refusal to their own codes', async () => {
    const refusal = (status: number) =>
      clientAnswering(() => Promise.resolve(new Response(null, { status }))).authorize(EXECUTION);

    await expect(refusal(409)).rejects.toMatchObject({
      status: 409,
      code: 'transcription_execution_lost',
    });
    await expect(refusal(404)).rejects.toMatchObject({
      status: 404,
      code: 'transcription_not_found',
    });
    // Any other 4xx is Core saying no for good: answered as a refusal, not a gateway fault the
    // worker would retry.
    for (const status of [400, 401, 403, 422]) {
      await expect(refusal(status)).rejects.toMatchObject({
        status: 403,
        code: 'transcription_authorization_refused',
      });
    }
  });

  it.each([
    ['a tenant that is not a uuid', { ...GRANT, tenantId: 'tenant' }],
    ['a missing principal', { ...GRANT, principalId: undefined }],
    ['a workspace that is not a uuid', { ...GRANT, workspaceId: 7 }],
    ['a note that is not a uuid', { ...GRANT, noteItemId: '' }],
    ['an audio item that is not a uuid', { ...GRANT, audioItemId: null }],
    ['a title that is not a string', { ...GRANT, audioTitle: 12 }],
    ['a title over the limit', { ...GRANT, audioTitle: 't'.repeat(501) }],
    ['a read-only grant', { ...GRANT, canWrite: false }],
    ['a truthy but non-boolean grant', { ...GRANT, canWrite: 'true' }],
    ['an array', [GRANT]],
  ])('refuses a successful response with %s', async (_name, answer) => {
    await expect(
      clientAnswering(() => Promise.resolve(Response.json(answer))).authorize(EXECUTION),
    ).rejects.toMatchObject({ status: 502, code: 'transcription_authorization_invalid' });
  });

  it('refuses a successful response that is not JSON', async () => {
    await expect(
      clientAnswering(() => Promise.resolve(new Response('<html>', { status: 200 }))).authorize(
        EXECUTION,
      ),
    ).rejects.toMatchObject({ status: 502, code: 'transcription_authorization_invalid' });
  });

  it('accepts a title of exactly the limit and an empty one', async () => {
    const atLimit = { ...GRANT, audioTitle: 't'.repeat(500) };
    await expect(
      clientAnswering(() => Promise.resolve(Response.json(atLimit))).authorize(EXECUTION),
    ).resolves.toMatchObject({ audioTitle: atLimit.audioTitle });
    await expect(
      clientAnswering(() => Promise.resolve(Response.json({ ...GRANT, audioTitle: '' }))).authorize(
        EXECUTION,
      ),
    ).resolves.toMatchObject({ audioTitle: '' });
  });
});
