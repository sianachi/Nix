import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import { nixSchema } from '@nix/editor-schema';
import { saveProfile } from '../config.ts';
import { outputOptions } from '../output.ts';
import { readNote } from './notes.ts';

const API = 'http://nix.test';
const COLLAB = 'http://nix.test:8100';
const ITEM = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';

function itemOf(type: string): Record<string, unknown> {
  return {
    id: ITEM,
    workspaceId: WORKSPACE,
    parentId: null,
    type,
    title: 'Thing',
    hasChildren: false,
    seq: 1000,
    lifecycleState: 'active',
    properties: {},
    createdAt: '2026-08-19T09:00:00.000Z',
    updatedAt: '2026-08-19T09:00:00.000Z',
  };
}

function bodyUpdate(text: string): string {
  const prose = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
  const ydoc = prosemirrorJSONToYDoc(nixSchema, prose, 'default');
  return Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString('base64');
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
  const dir = await mkdtemp(join(tmpdir(), 'nixctl-notes-'));
  const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: dir };
  await saveProfile('default', { apiUrl: API, token: 'nixpat_abc', collabUrl: COLLAB }, { makeDefault: true, env });
  return { env, done: () => rm(dir, { recursive: true, force: true }) };
}

async function captureStdout(body: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return true;
  });
  try {
    await body();
  } finally {
    spy.mockRestore();
  }
  return lines.join('');
}

describe('note read', () => {
  it('refuses a canvas with a pointer to a lossless export, rather than reading it as an empty note', async () => {
    const { env, done } = await withProfile();
    server.use(http.get(`${API}/api/v1/items/:itemId`, () => HttpResponse.json(itemOf('canvas'))));

    await expect(
      captureStdout(() => readNote('default', ITEM, { raw: false }, outputOptions(true, { isTTY: false }), { env })),
    ).rejects.toThrow(/is a canvas, which Markdown cannot carry/);
    await done();
  });

  it('reads a note body as Markdown once the kind is confirmed prose', async () => {
    const { env, done } = await withProfile();
    server.use(
      http.get(`${API}/api/v1/items/:itemId`, () => HttpResponse.json(itemOf('note'))),
      http.get(`${COLLAB}/documents/:itemId/updates`, () =>
        HttpResponse.json({ docId: 'd1', headSeq: 1, schemaVersion: 2, updates: [{ seq: 1, update: bodyUpdate('Hello') }], hasMore: false }),
      ),
    );

    const out = await captureStdout(() =>
      readNote('default', ITEM, { raw: false }, outputOptions(true, { isTTY: false }), { env }),
    );

    const printed = JSON.parse(out) as { markdown: string };
    expect(printed.markdown.trim()).toBe('Hello');
    await done();
  });
});
