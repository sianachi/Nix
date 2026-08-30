import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveProfile } from '../config.ts';
import { outputOptions } from '../output.ts';
import { createItem, deleteItem, getItem, listItems, renameItem } from './items.ts';
import { listWorkspaces } from './workspaces.ts';

const API = 'http://nix.test';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const ITEM = '11111111-1111-4111-8111-111111111111';

/** A full item as the contract shapes it, so the client's schema accepts it. */
function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ITEM,
    workspaceId: WORKSPACE,
    parentId: null,
    type: 'note',
    title: 'Kickoff',
    hasChildren: false,
    seq: 1000,
    lifecycleState: 'active',
    properties: {},
    createdAt: '2026-08-19T09:00:00.000Z',
    updatedAt: '2026-08-19T09:00:00.000Z',
    ...overrides,
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
});

afterAll(() => {
  server.close();
});

/** Runs a command with stdout captured, returns the single JSON value it printed. */
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

/** A temp config with one signed-in profile; the caller cleans up. */
async function withProfile(): Promise<{ env: NodeJS.ProcessEnv; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'nixctl-items-'));
  const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: dir };
  await saveProfile('default', { apiUrl: API, token: 'nixpat_abc' }, { makeDefault: true, env });
  return { env, done: () => rm(dir, { recursive: true, force: true }) };
}

describe('the item commands over a stubbed workspace', () => {
  it("lists a workspace's children", async () => {
    const { env, done } = await withProfile();
    server.use(
      http.get(`${API}/api/v1/workspaces/:workspaceId/items`, () =>
        HttpResponse.json({
          items: [item(), item({ id: '33333333-3333-4333-8333-333333333333', title: 'Second' })],
          nextCursor: null,
        }),
      ),
    );

    const printed = (await capture((json) =>
      listItems('default', { workspaceId: WORKSPACE, includeDeleted: false }, json, { env }),
    )) as { count: number; items: { title: string }[] };

    expect(printed.count).toBe(2);
    expect(printed.items.map((row) => row.title)).toEqual(['Kickoff', 'Second']);
    // The list stays trimmed to shape - property values belong to `item get`, and this is the
    // assertion that keeps that split from eroding silently.
    expect(printed.items.every((row) => !('properties' in row))).toBe(true);
    await done();
  });

  it('reads one item by id, property values included', async () => {
    const { env, done } = await withProfile();
    server.use(
      http.get(`${API}/api/v1/items/:itemId`, () =>
        HttpResponse.json(item({ title: 'The one', properties: { status: 'done', count: 5 } })),
      ),
    );

    const printed = (await capture((json) => getItem('default', ITEM, json, { env }))) as {
      title: string;
      properties: Record<string, unknown>;
    };

    expect(printed.title).toBe('The one');
    // The values themselves, not just the keys - `props set` reports keys, this is the read-back.
    expect(printed.properties).toEqual({ status: 'done', count: 5 });
    await done();
  });

  it('creates an item and prints the created row', async () => {
    const { env, done } = await withProfile();
    server.use(
      http.post(`${API}/api/v1/workspaces/:workspaceId/items`, () =>
        HttpResponse.json(item({ title: 'Fresh' })),
      ),
    );

    const printed = (await capture((json) =>
      createItem('default', { workspaceId: WORKSPACE, type: 'note', title: 'Fresh' }, json, {
        env,
      }),
    )) as { title: string };

    expect(printed.title).toBe('Fresh');
    await done();
  });

  it('renames an item, sending the new title and printing the updated row', async () => {
    const { env, done } = await withProfile();
    let sentBody: unknown;
    server.use(
      http.patch(`${API}/api/v1/items/:itemId`, async ({ request }) => {
        sentBody = await request.json();
        return HttpResponse.json(item({ title: 'Renamed' }));
      }),
    );

    const printed = (await capture((json) =>
      renameItem('default', ITEM, WORKSPACE, 'Renamed', json, { env }),
    )) as { title: string };

    expect(sentBody).toEqual({ title: 'Renamed' });
    expect(printed.title).toBe('Renamed');
    await done();
  });

  it('reports a soft-delete as done', async () => {
    const { env, done } = await withProfile();
    server.use(
      http.delete(`${API}/api/v1/items/:itemId`, () => new HttpResponse(null, { status: 204 })),
    );

    const printed = await capture((json) => deleteItem('default', ITEM, WORKSPACE, json, { env }));

    expect(printed).toEqual({ id: ITEM, deleted: true });
    await done();
  });

  it('surfaces a not-found as a thrown API error the entry point maps to exit 4', async () => {
    const { env, done } = await withProfile();
    server.use(
      http.get(`${API}/api/v1/items/:itemId`, () =>
        HttpResponse.json(
          { code: 'items.not_found', detail: 'No item is visible.' },
          { status: 404 },
        ),
      ),
    );

    await expect(capture((json) => getItem('default', ITEM, json, { env }))).rejects.toMatchObject({
      status: 404,
    });
    await done();
  });
});

describe('ws list', () => {
  it('walks every workspace page', async () => {
    const { env, done } = await withProfile();
    server.use(
      http.get(`${API}/api/v1/workspaces`, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        return cursor === null
          ? HttpResponse.json({
              items: [
                {
                  id: '11111111-1111-4111-8111-111111111111',
                  name: 'Alpha',
                  versionRetentionDays: 30,
                  storageQuotaBytes: '1',
                  createdAt: '2026-08-30T12:00:00Z',
                  kind: 'personal',
                  canRename: true,
                  canManageMembers: true,
                  canLeave: false,
                },
              ],
              nextCursor: 'more',
            })
          : HttpResponse.json({
              items: [
                {
                  id: '33333333-3333-4333-8333-333333333333',
                  name: 'Beta',
                  versionRetentionDays: 30,
                  storageQuotaBytes: '1',
                  createdAt: '2026-08-30T12:00:00Z',
                  kind: 'shared',
                  canRename: false,
                  canManageMembers: false,
                  canLeave: true,
                },
              ],
              nextCursor: null,
            });
      }),
    );

    const printed = (await capture((json) => listWorkspaces('default', {}, json, { env }))) as {
      count: number;
      nextCursor: string | null;
      workspaces: { name: string; kind: string; canManageMembers: boolean }[];
    };

    expect(printed.count).toBe(1);
    expect(printed.workspaces.map((w) => w.name)).toEqual(['Alpha']);
    expect(printed.workspaces.map((w) => [w.kind, w.canManageMembers])).toEqual([
      ['personal', true],
    ]);
    expect(printed.nextCursor).toBe('more');
    await done();
  });
});
