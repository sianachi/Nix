import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveProfile } from '../config.ts';
import { outputOptions } from '../output.ts';
import { runSearch } from './search.ts';

const API = 'http://nix.test';

function hit(id: string, title: string): Record<string, unknown> {
  return { id, workspaceId: '22222222-2222-4222-8222-222222222222', type: 'note', title };
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
});
afterAll(() => {
  server.close();
});

async function withProfile(): Promise<{ env: NodeJS.ProcessEnv; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'nixctl-search-'));
  const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: dir };
  await saveProfile('default', { apiUrl: API, token: 'nixpat_abc' }, { makeDefault: true, env });
  return { env, done: () => rm(dir, { recursive: true, force: true }) };
}

async function capture(
  body: (json: ReturnType<typeof outputOptions>) => Promise<void>,
): Promise<unknown> {
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

describe('nixctl search', () => {
  it('passes the query and limit and prints the hits with the truncated flag', async () => {
    const { env, done } = await withProfile();
    let seenUrl: URL | undefined;
    server.use(
      http.get(`${API}/api/v1/search`, ({ request }) => {
        seenUrl = new URL(request.url);
        return HttpResponse.json({
          query: 'soup',
          results: [hit('a', 'Soup'), hit('b', 'Soup stock')],
          limit: 2,
          truncated: true,
        });
      }),
    );

    const printed = (await capture((json) =>
      runSearch('default', 'soup', { limit: 2 }, json, { env }),
    )) as {
      count: number;
      truncated: boolean;
      results: unknown[];
    };

    expect(seenUrl?.searchParams.get('q')).toBe('soup');
    expect(seenUrl?.searchParams.get('limit')).toBe('2');
    expect(printed.count).toBe(2);
    // A capped result set says so rather than looking complete.
    expect(printed.truncated).toBe(true);
    await done();
  });

  it('omits the limit parameter when none is given', async () => {
    const { env, done } = await withProfile();
    let seenUrl: URL | undefined;
    server.use(
      http.get(`${API}/api/v1/search`, ({ request }) => {
        seenUrl = new URL(request.url);
        return HttpResponse.json({ query: 'x', results: [], limit: 50, truncated: false });
      }),
    );

    await capture((json) => runSearch('default', 'x', {}, json, { env }));

    expect(seenUrl?.searchParams.has('limit')).toBe(false);
    await done();
  });
});
