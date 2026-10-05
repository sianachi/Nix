import { describe, expect, it, vi } from 'vitest';
import { NixApiError } from '@nix/api-client';
import {
  getRevisionState,
  listNamedVersions,
  listRevisions,
  nameVersion,
  restoreRevision,
} from './history.ts';

const COLLAB = 'http://collab.test';
const ITEM = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'jwt-1';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function problemResponse(status: number, code: string, detail: string): Response {
  return new Response(
    JSON.stringify({ type: 'about:blank', title: 'Request refused', status, code, detail }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

describe('listRevisions', () => {
  it('asks for the page with limit and, when given, before', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse({ revisions: [], hasMore: false, headSeq: 0 })),
    );

    await listRevisions({ collabUrl: COLLAB, itemId: ITEM, token: TOKEN, limit: 25, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(
      `${COLLAB}/documents/${ITEM}/history?limit=25`,
      expect.objectContaining({ headers: { authorization: `Bearer ${TOKEN}` } }),
    );

    await listRevisions({
      collabUrl: COLLAB,
      itemId: ITEM,
      token: TOKEN,
      limit: 25,
      before: 100,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenLastCalledWith(
      `${COLLAB}/documents/${ITEM}/history?limit=25&before=100`,
      expect.anything(),
    );
  });

  it('returns the revisions page as collab sent it', async () => {
    const page = {
      revisions: [
        {
          seq: 12,
          fromSeq: 8,
          actorId: 'user-1',
          startedAt: '2026-09-20T10:00:00.000Z',
          endedAt: '2026-09-20T10:05:00.000Z',
          updateCount: 4,
          name: null,
        },
      ],
      hasMore: false,
      headSeq: 12,
    };
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(page)));

    const result = await listRevisions({
      collabUrl: COLLAB,
      itemId: ITEM,
      token: TOKEN,
      limit: 50,
      fetchImpl,
    });

    expect(result).toEqual(page);
  });

  it('turns a problem document into a NixApiError the CLI can map to an exit code', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(problemResponse(404, 'document_not_found', 'No such item.')),
    );

    await expect(
      listRevisions({ collabUrl: COLLAB, itemId: ITEM, token: TOKEN, limit: 50, fetchImpl }),
    ).rejects.toMatchObject({ status: 404, code: 'document_not_found', detail: 'No such item.' });
  });

  it('falls back to a status-only failure when the response is not a problem document', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response('gateway timeout', { status: 502 })),
    );

    await expect(
      listRevisions({ collabUrl: COLLAB, itemId: ITEM, token: TOKEN, limit: 50, fetchImpl }),
    ).rejects.toMatchObject({ status: 502 });
  });
});

describe('getRevisionState', () => {
  it('reads the state at one seq', async () => {
    const state = { seq: 7, document: { type: 'doc', content: [] }, plaintext: 'hi', headSeq: 20 };
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(state)));

    const result = await getRevisionState({
      collabUrl: COLLAB,
      itemId: ITEM,
      token: TOKEN,
      seq: 7,
      fetchImpl,
    });

    expect(result).toEqual(state);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${COLLAB}/documents/${ITEM}/history/7`,
      expect.anything(),
    );
  });

  it('surfaces a 404 as history_state_unavailable when the seq is unreachable', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        problemResponse(404, 'history_state_unavailable', 'That revision is no longer retained.'),
      ),
    );

    const error = (await getRevisionState({
      collabUrl: COLLAB,
      itemId: ITEM,
      token: TOKEN,
      seq: 1,
      fetchImpl,
    }).catch((caught: unknown) => caught)) as NixApiError;

    expect(error).toBeInstanceOf(NixApiError);
    expect(error.status).toBe(404);
    expect(error.code).toBe('history_state_unavailable');
  });
});

describe('restoreRevision', () => {
  it('posts an empty body to the restore route and returns the new head', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ headSeq: 21 })));

    const result = await restoreRevision({
      collabUrl: COLLAB,
      itemId: ITEM,
      token: TOKEN,
      seq: 12,
      fetchImpl,
    });

    expect(result).toEqual({ headSeq: 21 });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${COLLAB}/documents/${ITEM}/history/12/restore`,
      expect.objectContaining({
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: '{}',
      }),
    );
  });

  it('propagates a refusal as a NixApiError with the refused status', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(problemResponse(403, 'auth.insufficient_scope', 'Cannot write this item.')),
    );

    await expect(
      restoreRevision({ collabUrl: COLLAB, itemId: ITEM, token: TOKEN, seq: 12, fetchImpl }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('listNamedVersions and nameVersion', () => {
  it('lists named versions as collab returns them', async () => {
    const versions = [
      {
        seq: 12,
        name: 'Before the rewrite',
        createdBy: 'user-1',
        createdAt: '2026-09-20T10:00:00Z',
      },
    ];
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ versions })));

    const result = await listNamedVersions({
      collabUrl: COLLAB,
      itemId: ITEM,
      token: TOKEN,
      fetchImpl,
    });

    expect(result).toEqual({ versions });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${COLLAB}/documents/${ITEM}/versions`,
      expect.anything(),
    );
  });

  it('posts the seq and name to pin a version', async () => {
    const created = {
      seq: 12,
      name: 'Before the rewrite',
      createdBy: 'user-1',
      createdAt: '2026-09-20T10:00:00Z',
    };
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(created, 201)));

    const result = await nameVersion({
      collabUrl: COLLAB,
      itemId: ITEM,
      token: TOKEN,
      seq: 12,
      name: 'Before the rewrite',
      fetchImpl,
    });

    expect(result).toEqual(created);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${COLLAB}/documents/${ITEM}/versions`,
      expect.objectContaining({
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ seq: 12, name: 'Before the rewrite' }),
      }),
    );
  });
});
