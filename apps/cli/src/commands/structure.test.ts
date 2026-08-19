import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveProfile } from '../config.ts';
import { outputOptions } from '../output.ts';
import { getSchema, parseAssignments, setProps, setSchema } from './structure.ts';

const API = 'http://nix.test';
const ITEM = '11111111-1111-4111-8111-111111111111';

/** A full ItemResponse, so the client's item schema parses a properties write. */
function item(props: Record<string, unknown>): Record<string, unknown> {
  return {
    id: ITEM,
    workspaceId: '22222222-2222-4222-8222-222222222222',
    parentId: null,
    type: 'note',
    title: 'Soup',
    hasChildren: false,
    seq: '1',
    lifecycleState: 'active',
    properties: props,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function propertyDef(key: string, type: string): Record<string, unknown> {
  return { key, label: key, type, options: [], required: false };
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

async function withProfile(): Promise<{ env: NodeJS.ProcessEnv; dir: string; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'nixctl-structure-'));
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

describe('parseAssignments', () => {
  it('parses JSON values where they parse and plain strings otherwise', () => {
    const bag = parseAssignments(['status=done', 'count=5', 'archived=null', 'due=2026-01-01', 'flag=true']);
    // A bare word is a string; a number is a number; null clears; a date is a string; a bool is a bool.
    expect(bag).toEqual({ status: 'done', count: 5, archived: null, due: '2026-01-01', flag: true });
  });

  it('refuses a pair with no key before the equals', () => {
    expect(() => parseAssignments(['=value'])).toThrow(/key=value/);
    expect(() => parseAssignments(['loose'])).toThrow(/key=value/);
  });
});

describe('nixctl props set', () => {
  it('sends the merged bag and reports which keys it set', async () => {
    const { env, done } = await withProfile();
    let sentBody: unknown;
    server.use(
      http.patch(`${API}/api/v1/items/:itemId/properties`, async ({ request }) => {
        sentBody = await request.json();
        return HttpResponse.json(item({ status: 'done', count: 5 }));
      }),
    );

    const printed = (await capture((json) =>
      setProps('default', ITEM, ['status=done', 'count=5', 'archived=null'], json, { env }),
    )) as { id: string; set: string[] };

    expect(sentBody).toEqual({ properties: { status: 'done', count: 5, archived: null } });
    expect(printed.set).toEqual(['status', 'count', 'archived']);
    expect(printed.id).toBe(ITEM);
    await done();
  });

  it('maps a not-found item to exit 4', async () => {
    const { env, done } = await withProfile();
    server.use(
      http.patch(`${API}/api/v1/items/:itemId/properties`, () =>
        HttpResponse.json({ code: 'items.not_found', detail: 'No item is visible.' }, { status: 404 }),
      ),
    );
    await expect(capture((json) => setProps('default', ITEM, ['a=1'], json, { env }))).rejects.toMatchObject({
      status: 404,
    });
    await done();
  });
});

describe('nixctl schema get', () => {
  it('prints the resolved schema, what is declared, and whether it inherits', async () => {
    const { env, done } = await withProfile();
    server.use(
      http.get(`${API}/api/v1/items/:itemId/schema`, () =>
        HttpResponse.json({
          properties: [propertyDef('status', 'select'), propertyDef('due', 'date')],
          declared: [propertyDef('due', 'date')],
          inherit: true,
        }),
      ),
    );

    const printed = (await capture((json) => getSchema('default', ITEM, json, { env }))) as {
      count: number;
      inherit: boolean;
      declared: unknown[];
    };

    expect(printed.count).toBe(2);
    expect(printed.inherit).toBe(true);
    expect(printed.declared).toHaveLength(1);
    await done();
  });
});

describe('nixctl schema set', () => {
  it('reads the file, sends the declared set, and prints the effective count', async () => {
    const { env, dir, done } = await withProfile();
    const file = join(dir, 'schema.json');
    await writeFile(
      file,
      JSON.stringify({ properties: [propertyDef('status', 'select')], inherit: false }),
      'utf8',
    );
    let sentBody: unknown;
    server.use(
      http.put(`${API}/api/v1/items/:itemId/schema`, async ({ request }) => {
        sentBody = await request.json();
        return HttpResponse.json({
          properties: [propertyDef('status', 'select')],
          declared: [propertyDef('status', 'select')],
          inherit: false,
        });
      }),
    );

    const printed = (await capture((json) => setSchema('default', ITEM, file, json, { env }))) as {
      count: number;
      inherit: boolean;
    };

    expect(sentBody).toEqual({ properties: [propertyDef('status', 'select')], inherit: false });
    expect(printed.count).toBe(1);
    expect(printed.inherit).toBe(false);
    await done();
  });

  it('refuses a file missing the inherit flag before any request', async () => {
    const { env, dir, done } = await withProfile();
    const file = join(dir, 'bad.json');
    await writeFile(file, JSON.stringify({ properties: [] }), 'utf8');
    // onUnhandledRequest:'error' would fail the test if it reached the network; it must not.
    await expect(capture((json) => setSchema('default', ITEM, file, json, { env }))).rejects.toThrow(/inherit/);
    await done();
  });
});
