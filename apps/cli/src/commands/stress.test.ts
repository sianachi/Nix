import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveProfile } from '../config.ts';
import { outputOptions } from '../output.ts';
import { seed } from './stress.ts';

const API = 'http://nix.test';
const WS = '22222222-2222-4222-8222-222222222222';

let nextId = 0;

/** A full ItemResponse, so the client's item schema parses each create. */
function itemFrom(body: { type?: string; title?: string; parentId?: string | null }): Record<string, unknown> {
  nextId += 1;
  const id = `00000000-0000-4000-8000-${String(nextId).padStart(12, '0')}`;
  return {
    id,
    workspaceId: WS,
    parentId: body.parentId ?? null,
    type: body.type ?? 'note',
    title: body.title ?? 'x',
    hasChildren: false,
    seq: '1',
    lifecycleState: 'active',
    properties: {},
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

const server = setupServer(
  http.post(`${API}/public/v1/auth/token`, () =>
    HttpResponse.json({ accessToken: 'jwt-1', tokenType: 'Bearer', expiresInSeconds: 600 }),
  ),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  server.resetHandlers();
  nextId = 0;
});
afterAll(() => {
  server.close();
});

async function withProfile(): Promise<{ env: NodeJS.ProcessEnv; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'nixctl-stress-'));
  const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: dir };
  await saveProfile('default', { apiUrl: API, token: 'nixpat_abc' }, { makeDefault: true, env });
  return { env, done: () => rm(dir, { recursive: true, force: true }) };
}

async function capture(body: (json: ReturnType<typeof outputOptions>) => Promise<void>): Promise<unknown> {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return true;
  });
  try {
    await body(outputOptions(true, { isTTY: false }));
  } finally {
    spy.mockRestore();
  }
  return JSON.parse(lines.join(''));
}

describe('nixctl stress seed', () => {
  it('creates a parent, then the requested children under it', async () => {
    const { env, done } = await withProfile();
    const parentIds: (string | null)[] = [];
    server.use(
      http.post(`${API}/api/v1/workspaces/:workspaceId/items`, async ({ request }) => {
        const body = (await request.json()) as { type?: string; title?: string; parentId?: string | null };
        parentIds.push(body.parentId ?? null);
        return HttpResponse.json(itemFrom(body));
      }),
    );

    const printed = (await capture((json) =>
      seed('default', { workspaceId: WS, count: 3 }, json, { env }),
    )) as { requested: number; created: number; stoppedEarly: boolean; parentId: string };

    expect(printed.requested).toBe(3);
    expect(printed.created).toBe(3);
    expect(printed.stoppedEarly).toBe(false);
    // Four creates in all: one parent (at the root, parentId null) then three children under it.
    expect(parentIds).toHaveLength(4);
    expect(parentIds[0]).toBeNull();
    expect(parentIds.slice(1)).toEqual([printed.parentId, printed.parentId, printed.parentId]);
    await done();
  });

  it('seeds under an existing parent without creating one', async () => {
    const { env, done } = await withProfile();
    const parent = '11111111-1111-4111-8111-111111111111';
    let creates = 0;
    server.use(
      http.post(`${API}/api/v1/workspaces/:workspaceId/items`, async ({ request }) => {
        creates += 1;
        const body = (await request.json()) as { type?: string; title?: string; parentId?: string | null };
        return HttpResponse.json(itemFrom(body));
      }),
    );

    const printed = (await capture((json) =>
      seed('default', { workspaceId: WS, count: 2, parentId: parent }, json, { env }),
    )) as { created: number; parentId: string };

    expect(printed.parentId).toBe(parent);
    expect(printed.created).toBe(2);
    // Only the two children, no parent create.
    expect(creates).toBe(2);
    await done();
  });

  it('stops on the write rate limit, keeping what it made and naming the override', async () => {
    const { env, done } = await withProfile();
    const parent = '11111111-1111-4111-8111-111111111111';
    let creates = 0;
    server.use(
      http.post(`${API}/api/v1/workspaces/:workspaceId/items`, async ({ request }) => {
        creates += 1;
        // The third child create meets the limit.
        if (creates === 3) {
          return HttpResponse.json(
            { code: 'rate.limited', detail: 'Too many writes.' },
            { status: 429 },
          );
        }
        const body = (await request.json()) as { type?: string; title?: string; parentId?: string | null };
        return HttpResponse.json(itemFrom(body));
      }),
    );

    const printed = (await capture((json) =>
      seed('default', { workspaceId: WS, count: 10, parentId: parent }, json, { env }),
    )) as { created: number; stoppedEarly: boolean; reason: string };

    expect(printed.stoppedEarly).toBe(true);
    expect(printed.created).toBe(2);
    expect(printed.reason).toContain('Nix__RateLimits__WritesPerMinute');
    await done();
  });

  it('rejects a non-positive count before opening a session', async () => {
    const { env, done } = await withProfile();
    await expect(capture((json) => seed('default', { workspaceId: WS, count: 0 }, json, { env }))).rejects.toThrow(
      /positive integer/,
    );
    await done();
  });
});
