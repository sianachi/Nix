import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saveProfile } from '../config.ts';
import { outputOptions } from '../output.ts';
import { readCanvas, writeCanvas } from './canvas.ts';

const API = 'http://nix.test';
const COLLAB = 'http://collab.test';
const ITEM = '11111111-1111-4111-8111-111111111111';
const DOC_ID = '22222222-2222-4222-8222-222222222222';
const server = setupServer(
  http.post(`${API}/public/v1/auth/token`, () =>
    HttpResponse.json({ accessToken: 'jwt-test', tokenType: 'Bearer', expiresInSeconds: 600 }),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function item(type: string): Record<string, unknown> {
  return {
    id: ITEM,
    workspaceId: '33333333-3333-4333-8333-333333333333',
    parentId: null,
    type,
    title: 'Architecture',
    hasChildren: false,
    seq: 1,
    lifecycleState: 'active',
    properties: {},
    createdAt: '2026-10-09T09:00:00.000Z',
    updatedAt: '2026-10-09T09:00:00.000Z',
  };
}

async function profile(): Promise<{ env: NodeJS.ProcessEnv; done: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'nixctl-canvas-'));
  const env = { XDG_CONFIG_HOME: directory };
  await saveProfile('canvas-test', { apiUrl: API, collabUrl: COLLAB, token: 'test-pat' }, { env });
  return { env, done: () => rm(directory, { recursive: true, force: true }) };
}

async function capture(run: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    await run();
    return chunks.join('');
  } finally {
    spy.mockRestore();
  }
}

describe('canvas commands', () => {
  it('refuses non-canvas items before accessing their bodies', async () => {
    const { env, done } = await profile();
    server.use(http.get(`${API}/api/v1/items/${ITEM}`, () => HttpResponse.json(item('note'))));
    try {
      await expect(readCanvas('canvas-test', ITEM, outputOptions(true), { env })).rejects.toThrow(
        /not a canvas/,
      );
    } finally {
      await done();
    }
  });

  it('refuses oversized supplied input before looking up or posting a canvas', async () => {
    const { env, done } = await profile();
    try {
      await expect(
        writeCanvas('canvas-test', ITEM, {}, outputOptions(true), {
          env,
          readStdin: () => Promise.resolve('x'.repeat(8 * 1024 * 1024 + 1)),
        }),
      ).rejects.toThrow(/exceeds 8 MiB/);
    } finally {
      await done();
    }
  });

  it('checks an input file size before reading it', async () => {
    const { env, done } = await profile();
    const directory = await mkdtemp(join(tmpdir(), 'nixctl-canvas-file-'));
    const path = join(directory, 'oversized.json');
    await writeFile(path, 'x'.repeat(8 * 1024 * 1024 + 1));
    try {
      await expect(
        writeCanvas('canvas-test', ITEM, { file: path }, outputOptions(true), { env }),
      ).rejects.toThrow(/exceeds 8 MiB/);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await done();
    }
  });

  it('reads and writes a canvas through the authenticated Collab boundary', async () => {
    const { env, done } = await profile();
    server.use(
      http.get(`${API}/api/v1/items/${ITEM}`, () => HttpResponse.json(item('canvas'))),
      http.get(`${COLLAB}/documents/${ITEM}/updates`, () =>
        HttpResponse.json({
          docId: DOC_ID,
          headSeq: 0,
          schemaVersion: 1,
          updates: [],
          hasMore: false,
        }),
      ),
      http.post(`${COLLAB}/documents/${ITEM}/updates`, async ({ request }) => {
        expect(request.headers.get('authorization')).toBe('Bearer jwt-test');
        expect(await request.json()).toMatchObject({ expectedDocId: DOC_ID });
        return HttpResponse.json({ seq: '1' }, { status: 202 });
      }),
    );
    try {
      await expect(
        capture(() => readCanvas('canvas-test', ITEM, outputOptions(true), { env })),
      ).resolves.toContain('"elements":[]');
      await expect(
        capture(() =>
          writeCanvas('canvas-test', ITEM, {}, outputOptions(true), {
            env,
            readStdin: () =>
              Promise.resolve(
                JSON.stringify({
                  elements: [{ id: 'core', type: 'rectangle', version: 1, versionNonce: 1 }],
                }),
              ),
          }),
        ),
      ).resolves.toContain('"written":true');
    } finally {
      await done();
    }
  });
});
