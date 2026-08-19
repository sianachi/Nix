import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveProfile } from '../config.ts';
import { outputOptions } from '../output.ts';
import { runExport } from './export.ts';

// The session derives collab :8100 and media :8200 from the API host, so an export routes to one of
// those two by format. The tests intercept both to prove the routing rather than assume it.
const API = 'http://nix.test';
const COLLAB = 'http://nix.test:8100';
const MEDIA = 'http://nix.test:8200';
const ITEM = '11111111-1111-4111-8111-111111111111';

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

async function withProfile(): Promise<{ env: NodeJS.ProcessEnv; dir: string; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'nixctl-export-'));
  const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: dir };
  await saveProfile('default', { apiUrl: API, token: 'nixpat_abc' }, { makeDefault: true, env });
  return { env, dir, done: () => rm(dir, { recursive: true, force: true }) };
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

describe('nixctl export', () => {
  it('routes md to the media service, writes the file, and reports the counts', async () => {
    const { env, dir, done } = await withProfile();
    const out = join(dir, 'soup.md');
    let seenUrl: URL | undefined;
    server.use(
      http.get(`${MEDIA}/documents/:itemId/export`, ({ request }) => {
        seenUrl = new URL(request.url);
        return new HttpResponse('# Soup\n', {
          headers: { 'x-nix-export-items': '1', 'x-nix-export-omitted': '0' },
        });
      }),
    );

    const printed = (await capture((json) =>
      runExport('default', ITEM, { format: 'md', scope: 'subtree', out }, json, { env }),
    )) as { file: string; bytes: number; items: number; format: string; scope: string };

    expect(seenUrl?.searchParams.get('format')).toBe('md');
    expect(seenUrl?.searchParams.get('scope')).toBe('subtree');
    expect(printed.items).toBe(1);
    expect(printed.format).toBe('md');
    expect(await readFile(out, 'utf8')).toBe('# Soup\n');
    await done();
  });

  it('routes nix to the collaboration service', async () => {
    const { env, dir, done } = await withProfile();
    const out = join(dir, 'soup.nix');
    let hitCollab = false;
    server.use(
      http.get(`${COLLAB}/documents/:itemId/export`, () => {
        hitCollab = true;
        return new HttpResponse(new Uint8Array([1, 2, 3]), {
          headers: { 'x-nix-export-items': '4', 'x-nix-export-omitted': '1' },
        });
      }),
    );

    const printed = (await capture((json) =>
      runExport('default', ITEM, { format: 'nix', scope: 'item', out }, json, { env }),
    )) as { bytes: number; omitted: number };

    expect(hitCollab).toBe(true);
    expect(printed.bytes).toBe(3);
    expect(printed.omitted).toBe(1);
    await done();
  });

  it('rejects an unknown format before opening a session', async () => {
    const { env, done } = await withProfile();
    await expect(
      capture((json) => runExport('default', ITEM, { format: 'html', scope: 'item', out: '/dev/null' }, json, { env })),
    ).rejects.toThrow(/Unknown format/);
    await done();
  });

  it('maps a not-found export to exit 4, passing the service detail through', async () => {
    const { env, dir, done } = await withProfile();
    server.use(
      http.get(`${MEDIA}/documents/:itemId/export`, () =>
        HttpResponse.json({ code: 'items.not_found', detail: 'That item is gone.' }, { status: 404 }),
      ),
    );
    await expect(
      capture((json) =>
        runExport('default', ITEM, { format: 'pdf', scope: 'item', out: join(dir, 'x.pdf') }, json, { env }),
      ),
    ).rejects.toMatchObject({ status: 404, detail: 'That item is gone.' });
    await done();
  });
});
