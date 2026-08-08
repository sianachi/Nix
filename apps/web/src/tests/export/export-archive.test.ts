import { describe, expect, it, vi } from 'vitest';

import { fileNameFrom, requestArchive, type ArchiveOutcome } from '../../export/export-archive';

/** The refusal, or a failed test. Narrows the outcome so the message can be read from it. */
function refusalOf(outcome: ArchiveOutcome): string {
  if (outcome.ok) {
    throw new Error('Expected a refusal, but the export succeeded.');
  }

  return outcome.error;
}

const ITEM = 'c1000000-0000-4000-8000-000000000031';

function ok(headers: Record<string, string> = {}): Response {
  return new Response(new Blob(['zip bytes']), {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': 'attachment; filename="notes.nix"',
      'x-nix-export-items': '3',
      'x-nix-export-omitted': '0',
      ...headers,
    },
  });
}

function request(overrides: Partial<Parameters<typeof requestArchive>[0]> = {}) {
  return requestArchive({
    itemId: ITEM,
    scope: 'subtree',
    getAccessToken: () => Promise.resolve('token'),
    fetchImpl: () => Promise.resolve(ok()),
    ...overrides,
  });
}

describe('requestArchive', () => {
  it('asks the collaboration service for the scope it was given, with the caller’s token', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(ok()));

    await request({ fetchImpl, scope: 'item' });

    expect(fetchImpl).toHaveBeenCalledWith(
      `/collab/documents/${ITEM}/export?scope=item`,
      expect.objectContaining({ headers: { authorization: 'Bearer token' } }),
    );
  });

  it('reports what the archive holds and what it left out', async () => {
    const outcome = await request({
      fetchImpl: () =>
        Promise.resolve(ok({ 'x-nix-export-items': '42', 'x-nix-export-omitted': '6' })),
    });

    expect(outcome).toMatchObject({
      ok: true,
      value: { itemCount: 42, omittedCount: 6, fileName: 'notes.nix' },
    });
  });

  it('says the session expired rather than sending an unauthenticated request', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(ok()));

    const outcome = await request({ getAccessToken: () => Promise.resolve(null), fetchImpl });

    expect(refusalOf(outcome)).toContain('session has expired');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('passes the service’s own refusal through rather than inventing one', async () => {
    const outcome = await request({
      fetchImpl: () =>
        Promise.resolve(
          new Response(JSON.stringify({ code: 'invalid_scope', detail: 'Not a scope.' }), {
            status: 400,
            headers: { 'content-type': 'application/problem+json' },
          }),
        ),
    });

    expect(outcome).toEqual({ ok: false, error: 'Not a scope.' });
  });

  it('does not claim a reason when the refusal carries none', async () => {
    const outcome = await request({
      fetchImpl: () => Promise.resolve(new Response('<html>gateway</html>', { status: 502 })),
    });

    expect(refusalOf(outcome)).toContain('502');
  });

  it('reports a cancelled export as cancelled, not as a failure to reach the service', async () => {
    const outcome = await request({
      fetchImpl: () => Promise.reject(new DOMException('aborted', 'AbortError')),
    });

    expect(outcome).toEqual({ ok: false, error: 'The export was cancelled.' });
  });

  it('treats a missing count header as nothing rather than as NaN', async () => {
    const outcome = await request({
      fetchImpl: () =>
        Promise.resolve(
          new Response(new Blob(['zip']), {
            status: 200,
            headers: { 'content-disposition': 'attachment; filename="a.nix"' },
          }),
        ),
    });

    expect(outcome).toMatchObject({ ok: true, value: { itemCount: 0, omittedCount: 0 } });
  });
});

describe('fileNameFrom', () => {
  it('takes the name the service chose', () => {
    expect(fileNameFrom('attachment; filename="quarterly-review.nix"')).toBe(
      'quarterly-review.nix',
    );
  });

  it('falls back rather than downloading something with no name', () => {
    expect(fileNameFrom(null)).toBe('export.nix');
    expect(fileNameFrom('attachment')).toBe('export.nix');
  });
});
