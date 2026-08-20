import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { saveProfile } from '../config.ts';
import { outputOptions } from '../output.ts';
import { runImport } from './import.ts';

const API = 'http://nix.test';
const COLLAB = 'http://nix.test:8100';
const WS = '22222222-2222-4222-8222-222222222222';

let nextId = 0;

/** A full ItemResponse, so the client's item schema parses each create. */
function itemFrom(body: {
  type?: string;
  title?: string;
  parentId?: string | null;
}): Record<string, unknown> {
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
  // The command reports partial imports through the exit code; a test must not leak that into the
  // runner's own exit.
  process.exitCode = 0;
});
afterAll(() => {
  server.close();
});

async function withProfile(): Promise<{ env: NodeJS.ProcessEnv; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'nixctl-import-'));
  const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: dir };
  await saveProfile(
    'default',
    { apiUrl: API, token: 'nixpat_abc', collabUrl: COLLAB },
    { makeDefault: true, env },
  );
  return { env, done: () => rm(dir, { recursive: true, force: true }) };
}

/** A source tree: two notes (one with front matter), a non-Markdown file, and a nested folder. */
async function withSourceTree(): Promise<{ dir: string; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'nixctl-import-src-'));
  await writeFile(
    join(dir, 'a-first.md'),
    '---\ntitle: First Note\nstatus: done\ncount: 5\n- a list item\n---\n' +
      'Hello **world**, a [[Wiki Link]], a local image ![pic](./img.png) and a remote one ![web](https://example.test/a.png).\n',
    'utf8',
  );
  await writeFile(join(dir, 'notes.txt'), 'not markdown', 'utf8');
  await mkdir(join(dir, 'sub'));
  await writeFile(join(dir, 'sub', 'nested.md'), 'Nested body.\n', 'utf8');
  return { dir, done: () => rm(dir, { recursive: true, force: true }) };
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

/** The handlers a fully-green import needs; individual tests override the parts they break. */
function greenHandlers(record: {
  parents?: (string | null)[];
  propertyPatches?: Record<string, unknown>[];
  bodyWrites?: { count: number };
}): Parameters<typeof server.use> {
  return [
    http.post(`${API}/api/v1/workspaces/:workspaceId/items`, async ({ request }) => {
      const body = (await request.json()) as {
        type?: string;
        title?: string;
        parentId?: string | null;
      };
      record.parents?.push(body.parentId ?? null);
      return HttpResponse.json(itemFrom(body));
    }),
    http.post(`${COLLAB}/documents/:itemId/updates`, () => {
      if (record.bodyWrites !== undefined) {
        record.bodyWrites.count += 1;
      }
      return HttpResponse.json({ seq: 's1' });
    }),
    http.patch(`${API}/api/v1/items/:itemId/properties`, async ({ request }) => {
      const body = (await request.json()) as { properties: Record<string, unknown> };
      record.propertyPatches?.push(body.properties);
      return HttpResponse.json(itemFrom({}));
    }),
  ];
}

// `splitFrontMatter` and `parseScalar` live in `@nix/markdown` (shared with the web import) and
// are tested there; these tests cover what the CLI does with their output.

describe('nixctl import --dry-run', () => {
  it('previews the mapping - titles, properties, declared losses, skips - without touching the network', async () => {
    const { env, done } = await withProfile();
    const { dir, done: dropTree } = await withSourceTree();

    // No handlers beyond the token exchange are registered, and unhandled requests error: a dry
    // run that reached the network would fail this test by construction. It does not even need
    // the token.
    const printed = (await capture((json) =>
      runImport(
        'default',
        { path: dir, workspaceId: WS, parentId: undefined, dryRun: true },
        json,
        { env },
      ),
    )) as {
      dryRun: boolean;
      planned: {
        path: string;
        kind: string;
        title: string;
        properties: string[];
        sourceBytes: number;
        unresolvedWikiLinks: number;
        unresolvedLocalImages: number;
      }[];
      skipped: { path: string; reason: string }[];
      failed: unknown[];
    };

    expect(printed.dryRun).toBe(true);
    expect(printed.planned.map((entry) => entry.title)).toEqual([
      basename(dir),
      'First Note',
      'sub',
      'nested',
    ]);
    const first = printed.planned[1];
    expect(first?.properties).toEqual(['status', 'count']);
    expect(first?.sourceBytes).toBeGreaterThan(0);
    expect(first?.unresolvedWikiLinks).toBe(1);
    // The local image counts; the https one is an address the workspace can keep.
    expect(first?.unresolvedLocalImages).toBe(1);
    expect(printed.skipped).toEqual([
      { path: join(dir, 'notes.txt'), reason: 'not a Markdown file' },
    ]);
    expect(printed.failed).toEqual([]);
    expect(process.exitCode ?? 0).toBe(0);
    await dropTree();
    await done();
  });
});

describe('nixctl import', () => {
  it('imports a folder tree as a coherent item tree with bodies and properties', async () => {
    const { env, done } = await withProfile();
    const { dir, done: dropTree } = await withSourceTree();

    const parents: (string | null)[] = [];
    const propertyPatches: Record<string, unknown>[] = [];
    const bodyWrites = { count: 0 };
    server.use(...greenHandlers({ parents, propertyPatches, bodyWrites }));

    const printed = (await capture((json) =>
      runImport(
        'default',
        { path: dir, workspaceId: WS, parentId: undefined, dryRun: false },
        json,
        { env },
      ),
    )) as {
      rootItemId: string;
      createdCount: number;
      stoppedEarly: boolean;
      notAttempted: unknown[];
      created: {
        path: string;
        itemId: string;
        title: string;
        properties: string[];
        bodyBytes: number;
      }[];
    };

    expect(printed.createdCount).toBe(4);
    expect(printed.stoppedEarly).toBe(false);
    expect(printed.notAttempted).toEqual([]);
    // The tree is coherent: the folder is the root, both notes and the subfolder hang beneath it.
    expect(parents[0]).toBeNull();
    expect(parents[1]).toBe(printed.rootItemId);
    expect(parents[2]).toBe(printed.rootItemId);
    const sub = printed.created.find((entry) => entry.title === 'sub');
    expect(parents[3]).toBe(sub?.itemId);
    // Both note bodies were written; the front matter became one property patch, title excluded.
    expect(bodyWrites.count).toBe(2);
    expect(propertyPatches).toEqual([{ status: 'done', count: 5 }]);
    const first = printed.created.find((entry) => entry.title === 'First Note');
    expect(first?.bodyBytes).toBeGreaterThan(0);
    // A whole import is a success a script can branch on.
    expect(process.exitCode ?? 0).toBe(0);
    await done();
    await dropTree();
  });

  it('imports under the named parent when --parent is given', async () => {
    const { env, done } = await withProfile();
    const parent = '11111111-1111-4111-8111-111111111111';
    const dir = await mkdtemp(join(tmpdir(), 'nixctl-import-one-'));
    const file = join(dir, 'solo.md');
    await writeFile(file, 'Solo body.\n', 'utf8');

    const parents: (string | null)[] = [];
    server.use(...greenHandlers({ parents }));

    await capture((json) =>
      runImport('default', { path: file, workspaceId: WS, parentId: parent, dryRun: false }, json, {
        env,
      }),
    );

    expect(parents).toEqual([parent]);
    await rm(dir, { recursive: true, force: true });
    await done();
  });

  it('puts the subtree of a failed container in notAttempted, keeps the refusal verbatim, and exits non-zero', async () => {
    const { env, done } = await withProfile();
    const { dir, done: dropTree } = await withSourceTree();

    server.use(...greenHandlers({}));
    server.use(
      http.post(`${API}/api/v1/workspaces/:workspaceId/items`, async ({ request }) => {
        const body = (await request.json()) as {
          type?: string;
          title?: string;
          parentId?: string | null;
        };
        if (body.title === 'sub') {
          return HttpResponse.json(
            {
              type: 'about:blank',
              title: 'Server error',
              status: 500,
              detail: 'boom',
              code: 'server.error',
            },
            { status: 500, headers: { 'content-type': 'application/problem+json' } },
          );
        }
        return HttpResponse.json(itemFrom(body));
      }),
    );

    const printed = (await capture((json) =>
      runImport(
        'default',
        { path: dir, workspaceId: WS, parentId: undefined, dryRun: false },
        json,
        { env },
      ),
    )) as {
      createdCount: number;
      failed: { path: string; reason: string }[];
      notAttempted: { path: string; reason: string }[];
    };

    // Root and the first note made it; `sub` failed with the service's own words; `nested.md` is
    // accounted for rather than vanishing.
    expect(printed.createdCount).toBe(2);
    expect(printed.failed).toEqual([{ path: join(dir, 'sub'), reason: 'boom' }]);
    expect(printed.notAttempted).toEqual([
      { path: join(dir, 'sub', 'nested.md'), reason: 'its parent was not imported' },
    ]);
    expect(process.exitCode).toBe(1);
    await dropTree();
    await done();
  });

  it('reports an item whose body write was refused as created-with-a-loss, keeping its id', async () => {
    const { env, done } = await withProfile();
    const dir = await mkdtemp(join(tmpdir(), 'nixctl-import-body-'));
    await writeFile(join(dir, 'note.md'), 'A body.\n', 'utf8');

    server.use(...greenHandlers({}));
    server.use(
      http.post(`${COLLAB}/documents/:itemId/updates`, () =>
        HttpResponse.json({ detail: 'collab refused the body' }, { status: 503 }),
      ),
    );

    const printed = (await capture((json) =>
      runImport(
        'default',
        { path: dir, workspaceId: WS, parentId: undefined, dryRun: false },
        json,
        { env },
      ),
    )) as {
      created: { title: string; itemId: string; bodyBytes: number; bodyError?: string }[];
      failed: unknown[];
    };

    // The item exists in the workspace, so the report says so and hands over its id; the loss is
    // declared on the row rather than the row pretending nothing was made.
    const note = printed.created.find((entry) => entry.title === 'note');
    expect(note?.itemId).toBeDefined();
    expect(note?.bodyBytes).toBe(0);
    expect(note?.bodyError).toBe('collab refused the body');
    expect(printed.failed).toEqual([]);
    expect(process.exitCode).toBe(1);
    await rm(dir, { recursive: true, force: true });
    await done();
  });

  it('reports an item whose property patch was refused as created-with-a-loss', async () => {
    const { env, done } = await withProfile();
    const dir = await mkdtemp(join(tmpdir(), 'nixctl-import-props-'));
    await writeFile(join(dir, 'note.md'), '---\nstatus: done\n---\nA body.\n', 'utf8');

    server.use(...greenHandlers({}));
    server.use(
      http.patch(`${API}/api/v1/items/:itemId/properties`, () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Invalid',
            status: 422,
            detail: 'no such property',
            code: 'schema.unknown_property',
          },
          { status: 422, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    const printed = (await capture((json) =>
      runImport(
        'default',
        { path: dir, workspaceId: WS, parentId: undefined, dryRun: false },
        json,
        { env },
      ),
    )) as { created: { title: string; propertiesError?: string }[] };

    const note = printed.created.find((entry) => entry.title === 'note');
    expect(note?.propertiesError).toBe('no such property');
    expect(process.exitCode).toBe(1);
    await rm(dir, { recursive: true, force: true });
    await done();
  });

  it('stops honestly at the write rate limit: keeps what it made, lists the rest, and does not promise a resume', async () => {
    const { env, done } = await withProfile();
    const { dir, done: dropTree } = await withSourceTree();

    let creates = 0;
    server.use(...greenHandlers({}));
    server.use(
      http.post(`${API}/api/v1/workspaces/:workspaceId/items`, async ({ request }) => {
        creates += 1;
        if (creates >= 2) {
          return HttpResponse.json(
            { code: 'rate.limited', detail: 'Too many writes.' },
            { status: 429 },
          );
        }
        const body = (await request.json()) as {
          type?: string;
          title?: string;
          parentId?: string | null;
        };
        return HttpResponse.json(itemFrom(body));
      }),
    );

    const printed = (await capture((json) =>
      runImport(
        'default',
        { path: dir, workspaceId: WS, parentId: undefined, dryRun: false },
        json,
        { env },
      ),
    )) as {
      createdCount: number;
      stoppedEarly: boolean;
      reason: string;
      rootItemId: string;
      notAttempted: { path: string; reason: string }[];
    };

    expect(printed.stoppedEarly).toBe(true);
    expect(printed.createdCount).toBe(1);
    // The one handle that removes the partial import is reported, and the advice names it rather
    // than suggesting a re-run the command cannot deduplicate.
    expect(printed.rootItemId).toBe('00000000-0000-4000-8000-000000000001');
    expect(printed.reason).toContain('Nix__RateLimits__WritesPerMinute');
    expect(printed.reason).toContain('nixctl item rm');
    expect(printed.reason).not.toContain('re-run against what remains');
    // Everything the stop abandoned is accounted for.
    expect(printed.notAttempted.map((entry) => entry.path).sort()).toEqual(
      [join(dir, 'a-first.md'), join(dir, 'sub'), join(dir, 'sub', 'nested.md')].sort(),
    );
    expect(
      printed.notAttempted.every((entry) => entry.reason === 'stopped at the write rate limit'),
    ).toBe(true);
    expect(process.exitCode).toBe(1);
    await dropTree();
    await done();
  });

  it('refuses a single file that is not Markdown, naming the reason', async () => {
    const { env, done } = await withProfile();
    const dir = await mkdtemp(join(tmpdir(), 'nixctl-import-txt-'));
    const file = join(dir, 'notes.txt');
    await writeFile(file, 'plain text', 'utf8');

    await expect(
      capture((json) =>
        runImport(
          'default',
          { path: file, workspaceId: WS, parentId: undefined, dryRun: false },
          json,
          { env },
        ),
      ),
    ).rejects.toThrow(/not a Markdown file/);

    await rm(dir, { recursive: true, force: true });
    await done();
  });

  it('does not follow a symbolic link and skips hidden directories, reporting both', async () => {
    const { env, done } = await withProfile();
    const dir = await mkdtemp(join(tmpdir(), 'nixctl-import-link-'));
    await writeFile(join(dir, 'real.md'), 'Real.\n', 'utf8');
    // A cycle: the link points back at the folder that contains it. And a vault's private space.
    await symlink(dir, join(dir, 'loop'));
    await mkdir(join(dir, '.obsidian'));
    await writeFile(join(dir, '.obsidian', 'config.md'), 'tool config', 'utf8');

    const printed = (await capture((json) =>
      runImport(
        'default',
        { path: dir, workspaceId: WS, parentId: undefined, dryRun: true },
        json,
        { env },
      ),
    )) as { planned: { title: string }[]; skipped: { path: string; reason: string }[] };

    expect(printed.planned.map((entry) => entry.title)).toEqual([basename(dir), 'real']);
    expect(printed.skipped).toEqual([
      { path: join(dir, '.obsidian'), reason: 'hidden directory, not imported' },
      { path: join(dir, 'loop'), reason: 'symbolic link, not followed' },
    ]);
    await rm(dir, { recursive: true, force: true });
    await done();
  });
});
