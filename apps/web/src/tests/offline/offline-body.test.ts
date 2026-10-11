import 'fake-indexeddb/auto';
import { Blob as BufferBlob } from 'node:buffer';
import { createNixClient, type NixClient } from '@nix/api-client';
import { SCHEMA_VERSION } from '@nix/editor-schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { z } from 'zod';

import {
  bodyCacheSealed,
  clearBodyCache,
  documentScope,
  openBodyCache,
  readBodyCache,
  reopenRefusedItemBodies,
  sealItemBodies,
  writeBodyCache,
} from '../../editor/body-cache';
import {
  clearDrafts,
  createDraftJournal,
  readDrafts,
  writeDraft,
} from '../../editor/draft-journal';
import { synchronizeOfflineBody } from '../../offline/offline-body';
import { clearOfflineData, rememberOfflineAccount } from '../../offline/offline-store';

const SUBJECT = 'offline-body-person';
const WORKSPACE = 'b0000000-0000-4000-8000-000000000001';
const ITEM = 'b0000000-0000-4000-8000-000000000002';
const DOC_ID = 'b0000000-0000-4000-8000-000000000003';
const REPLACEMENT_DOC_ID = 'b0000000-0000-4000-8000-000000000004';
const documents = new Set<Y.Doc>();
const uploadSchema = z.object({
  update: z.string(),
  clientId: z.string(),
  expectedDocId: z.string(),
});

interface Page {
  readonly docId: string;
  readonly headSeq: string;
  readonly schemaVersion: number;
  readonly canWrite: boolean;
  readonly checkpoint?: { readonly seq: string; readonly update: string };
  readonly updates: readonly { readonly seq: string; readonly update: string }[];
  readonly hasMore: boolean;
}

function localStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => {
      values.clear();
    },
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function scope(itemId = ITEM): string {
  const result = documentScope(SUBJECT, WORKSPACE, itemId, 'note');
  if (result === undefined) throw new Error('Missing note scope.');
  return result;
}

function document(text?: string): Y.Doc {
  const doc = new Y.Doc();
  if (text !== undefined) doc.getText('body').insert(0, text);
  documents.add(doc);
  return doc;
}

function deferred(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release: () => void = () => {
    throw new Error('The deferred operation was not initialized.');
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    release: () => {
      release();
    },
  };
}

function base64(update: Uint8Array): string {
  return Buffer.from(update).toString('base64');
}

function page(doc: Y.Doc, overrides: Partial<Page> = {}): Page {
  return {
    docId: DOC_ID,
    headSeq: '10',
    schemaVersion: SCHEMA_VERSION,
    canWrite: true,
    checkpoint: { seq: '10', update: base64(Y.encodeStateAsUpdate(doc)) },
    updates: [],
    hasMore: false,
    ...overrides,
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function transport(
  server = document('Server text'),
  options: {
    readonly canWrite?: boolean;
    readonly getPage?: (request: URL, count: number) => Page | Promise<Page>;
    readonly onPost?: () => Promise<void>;
    readonly postRefusal?: { readonly status: number; readonly code: string };
    readonly postDocId?: string;
  } = {},
): {
  readonly client: NixClient;
  readonly gets: URL[];
  readonly uploads: z.infer<typeof uploadSchema>[];
  readonly server: Y.Doc;
} {
  const gets: URL[] = [];
  const uploads: z.infer<typeof uploadSchema>[] = [];
  let seq = 10;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      expect(url.pathname).toMatch(/^\/collab\/documents\/[0-9a-f-]+\/updates$/u);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer offline-token');
      if (init?.method === 'POST') {
        if (typeof init.body !== 'string') throw new Error('Expected a JSON update.');
        const upload = uploadSchema.parse(JSON.parse(init.body));
        expect(upload.expectedDocId).toBe(DOC_ID);
        uploads.push(upload);
        if (options.postRefusal !== undefined)
          return new Response(JSON.stringify({ title: 'Write refused', ...options.postRefusal }), {
            status: options.postRefusal.status,
            headers: { 'Content-Type': 'application/problem+json' },
          });
        Y.applyUpdate(server, new Uint8Array(Buffer.from(upload.update, 'base64')));
        seq += 1;
        await options.onPost?.();
        return json(
          { docId: options.postDocId ?? DOC_ID, seq: String(seq), snapshotWritten: true },
          202,
        );
      }
      gets.push(url);
      return json(
        options.getPage === undefined
          ? page(server, {
              headSeq: String(seq),
              canWrite: options.canWrite ?? true,
              checkpoint: { seq: String(seq), update: base64(Y.encodeStateAsUpdate(server)) },
            })
          : await options.getPage(url, gets.length),
      );
    }),
  );
  const client = createNixClient({
    baseUrl: 'http://offline-body.test',
    tokens: {
      getAccessToken: () => Promise.resolve('offline-token'),
      refreshAccessToken: () => Promise.resolve(null),
    },
  });
  return { client, gets, uploads, server };
}

function synchronize(
  client: NixClient,
  doc = document(),
  options: { readonly itemId?: string; readonly onReadOnly?: () => Promise<void> } = {},
) {
  return synchronizeOfflineBody({
    client,
    subject: SUBJECT,
    workspaceId: WORKSPACE,
    itemId: options.itemId ?? ITEM,
    doc,
    signal: new AbortController().signal,
    ...options,
  });
}

async function cache(doc: Y.Doc, docId = DOC_ID): Promise<void> {
  await writeBodyCache({
    scope: scope(),
    docId,
    schemaVersion: SCHEMA_VERSION,
    savedAt: Date.now(),
    update: Y.encodeStateAsUpdate(doc),
  });
}

async function pending(doc: Y.Doc, text = ' offline edit') {
  const journal = createDraftJournal(scope(), () => undefined);
  await journal.read();
  await journal.bindDocument(DOC_ID);
  const before = Y.encodeStateVector(doc);
  doc.getText('body').insert(doc.getText('body').length, text);
  journal.append(Y.encodeStateAsUpdate(doc, before));
  await journal.snapshot();
  return journal;
}

beforeEach(async () => {
  vi.stubGlobal('localStorage', localStorage());
  vi.stubGlobal('Blob', BufferBlob);
  await clearBodyCache();
  await clearDrafts();
  await clearOfflineData();
  await rememberOfflineAccount({ subject: SUBJECT, name: 'Offline body person', email: null });
  await openBodyCache(SUBJECT);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const doc of documents) doc.destroy();
  documents.clear();
});

describe('stateless offline body synchronization', () => {
  it.each(['account', 'item'] as const)(
    'refuses a delayed download after the %s storage lifecycle is reopened',
    async (lifecycle) => {
      const server = document('Base');
      const editing = document();
      Y.applyUpdate(editing, Y.encodeStateAsUpdate(server));
      await cache(server);
      await pending(editing);
      const oldDraft = (await readDrafts(scope()))[0];
      if (oldDraft === undefined) throw new Error('Missing pending edit.');
      const requested = deferred();
      const continued = deferred();
      const remote = transport(server, {
        getPage: async () => {
          requested.release();
          await continued.promise;
          return page(server);
        },
      });
      const outcome = synchronize(remote.client).catch((cause: unknown) => cause);
      await requested.promise;
      if (lifecycle === 'account') {
        await clearBodyCache(SUBJECT);
        await openBodyCache(SUBJECT);
      } else {
        await sealItemBodies(SUBJECT, WORKSPACE, ITEM, 'refused');
        reopenRefusedItemBodies(SUBJECT, WORKSPACE, ITEM);
      }
      await cache(document('New lifecycle body'));
      await writeDraft({
        ...oldDraft,
        update: Y.encodeStateAsUpdate(document('New lifecycle pending edit')),
      });
      const retainedCache = await readBodyCache(scope());
      const retainedDrafts = await readDrafts(scope());
      continued.release();

      expect(await outcome).toBeInstanceOf(Error);
      expect(remote.gets).toHaveLength(1);
      expect(remote.uploads).toEqual([]);
      expect(await readBodyCache(scope())).toEqual(retainedCache);
      expect(await readDrafts(scope())).toEqual(retainedDrafts);
    },
  );

  it('refuses a delayed upload response after the same account starts another storage lifecycle', async () => {
    const server = document('Base');
    const editing = document();
    Y.applyUpdate(editing, Y.encodeStateAsUpdate(server));
    await cache(server);
    await pending(editing);
    const oldDraft = (await readDrafts(scope()))[0];
    if (oldDraft === undefined) throw new Error('Missing pending edit.');
    const uploaded = deferred();
    const continued = deferred();
    const remote = transport(server, {
      onPost: async () => {
        uploaded.release();
        await continued.promise;
      },
    });
    const outcome = synchronize(remote.client).catch((cause: unknown) => cause);
    await uploaded.promise;
    await clearBodyCache(SUBJECT);
    await openBodyCache(SUBJECT);
    await cache(document('New lifecycle body'));
    await writeDraft({
      ...oldDraft,
      update: Y.encodeStateAsUpdate(document('New lifecycle pending edit')),
    });
    const retainedCache = await readBodyCache(scope());
    const retainedDrafts = await readDrafts(scope());
    continued.release();

    expect(await outcome).toBeInstanceOf(Error);
    expect(remote.gets).toHaveLength(1);
    expect(remote.uploads).toHaveLength(1);
    expect(await readBodyCache(scope())).toEqual(retainedCache);
    expect(await readDrafts(scope())).toEqual(retainedDrafts);
  });

  it('refuses a previous account even if its body cache is still open', async () => {
    await rememberOfflineAccount({
      subject: 'another-person',
      name: 'Another person',
      email: null,
    });
    await openBodyCache(SUBJECT);
    const remote = transport();

    await expect(synchronize(remote.client)).rejects.toThrow(/storage is closed/iu);

    expect(remote.gets).toEqual([]);
    expect(remote.uploads).toEqual([]);
    expect(await readBodyCache(scope())).toBeNull();
  });

  it('downloads 250 notes without opening WebSockets', async () => {
    const websocket = vi.fn(() => {
      throw new Error('A corpus download must use HTTP.');
    });
    vi.stubGlobal('WebSocket', websocket);
    const remote = transport();
    for (let index = 0; index < 250; index += 1) {
      const itemId = `c0000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      await synchronize(remote.client, document(), { itemId });
      const saved = await readBodyCache(scope(itemId));
      expect(saved?.docId).toBe(DOC_ID);
      const reopened = document();
      if (saved === null) throw new Error('The note was not saved.');
      Y.applyUpdate(reopened, saved.update);
      expect(reopened.getText('body').toJSON()).toBe('Server text');
    }
    expect(remote.gets).toHaveLength(250);
    expect(remote.uploads).toEqual([]);
    expect(websocket).not.toHaveBeenCalled();
  });

  it('uploads and durably caches pending edits for 250 isolated note scopes without WebSockets', async () => {
    const websocket = vi.fn(() => {
      throw new Error('Pending corpus synchronization must use HTTP.');
    });
    vi.stubGlobal('WebSocket', websocket);
    const server = document('Synthetic shared server state');
    const remote = transport(server);
    for (let index = 0; index < 250; index += 1) {
      const itemId = `d0000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      const editing = document();
      Y.applyUpdate(editing, Y.encodeStateAsUpdate(server));
      await writeBodyCache({
        scope: scope(itemId),
        docId: DOC_ID,
        schemaVersion: SCHEMA_VERSION,
        savedAt: Date.now(),
        update: Y.encodeStateAsUpdate(server),
      });
      const before = Y.encodeStateVector(editing);
      const edit = ` edit-${String(index)}`;
      editing.getText('body').insert(editing.getText('body').length, edit);
      await writeDraft({
        id: `${scope(itemId)}:pending`,
        scope: scope(itemId),
        docId: DOC_ID,
        revision: index,
        update: Y.encodeStateAsUpdate(editing, before),
      });

      await synchronize(remote.client, document(), { itemId });

      const saved = await readBodyCache(scope(itemId));
      if (saved === null) throw new Error('Missing confirmed pending note.');
      const reopened = document();
      Y.applyUpdate(reopened, saved.update);
      expect(reopened.getText('body').toJSON()).toBe(server.getText('body').toJSON());
      expect(reopened.getText('body').toJSON()).toContain(edit);
      expect(await readDrafts(scope(itemId))).toEqual([]);
    }
    expect(remote.gets).toHaveLength(500);
    expect(remote.uploads).toHaveLength(250);
    expect(websocket).not.toHaveBeenCalled();
  });

  it('reconstructs a retained checkpoint and its tail after covered updates were pruned', async () => {
    const server = document('Retained base');
    const checkpoint = base64(Y.encodeStateAsUpdate(server));
    const before = Y.encodeStateVector(server);
    server.getText('body').insert(13, ' and tail');
    const remote = transport(server, {
      getPage: () =>
        page(server, {
          headSeq: '11',
          checkpoint: { seq: '10', update: checkpoint },
          updates: [{ seq: '11', update: base64(Y.encodeStateAsUpdate(server, before)) }],
        }),
    });
    const local = document();

    await expect(synchronize(remote.client, local)).resolves.toEqual({
      docId: DOC_ID,
      canWrite: true,
    });

    expect(local.getText('body').toJSON()).toBe('Retained base and tail');
    expect(remote.gets[0]?.searchParams.get('fromCheckpoint')).toBe('true');
    expect(remote.uploads).toEqual([]);
    expect(await readBodyCache(scope())).not.toBeNull();
  });

  it('restarts bootstrap when retention leaves a gap instead of caching incomplete content', async () => {
    const server = document('All text after pruning');
    const old = document('Older checkpoint');
    const remote = transport(server, {
      getPage: (_request, count) =>
        count === 1
          ? page(server, {
              headSeq: '12',
              checkpoint: { seq: '10', update: base64(Y.encodeStateAsUpdate(old)) },
              updates: [{ seq: '12', update: base64(Y.encodeStateAsUpdate(server)) }],
            })
          : page(server, {
              headSeq: '12',
              checkpoint: { seq: '12', update: base64(Y.encodeStateAsUpdate(server)) },
            }),
    });
    const local = document();

    await synchronize(remote.client, local);

    expect(remote.gets).toHaveLength(2);
    expect(remote.gets.every((request) => request.searchParams.get('after') === '0')).toBe(true);
    expect(local.getText('body').toJSON()).toBe('All text after pruning');
    expect(remote.uploads).toEqual([]);
  });

  it('continues after a checkpoint through every tail page before caching the complete note', async () => {
    const server = document('Base');
    const checkpoint = base64(Y.encodeStateAsUpdate(server));
    const firstVector = Y.encodeStateVector(server);
    server.getText('body').insert(4, ' first');
    const first = base64(Y.encodeStateAsUpdate(server, firstVector));
    const secondVector = Y.encodeStateVector(server);
    server.getText('body').insert(10, ' second');
    const second = base64(Y.encodeStateAsUpdate(server, secondVector));
    const remote = transport(server, {
      getPage: (request, count) => {
        if (count === 1)
          return page(server, {
            headSeq: '12',
            checkpoint: { seq: '10', update: checkpoint },
            updates: [{ seq: '11', update: first }],
            hasMore: true,
          });
        expect(request.searchParams.get('after')).toBe('11');
        return {
          docId: DOC_ID,
          headSeq: '12',
          schemaVersion: SCHEMA_VERSION,
          canWrite: true,
          updates: [{ seq: '12', update: second }],
          hasMore: false,
        };
      },
    });
    const local = document();

    await synchronize(remote.client, local);

    expect(remote.gets).toHaveLength(2);
    expect(local.getText('body').toJSON()).toBe('Base first second');
    const saved = await readBodyCache(scope());
    if (saved === null) throw new Error('The paginated note was not saved.');
    const reopened = document();
    Y.applyUpdate(reopened, saved.update);
    expect(reopened.getText('body').toJSON()).toBe('Base first second');
  });

  it('refuses a changed server document identity before uploading and preserves pending edits', async () => {
    const old = document('Old body');
    await cache(old, 'old-document');
    await writeDraft({
      id: 'old-draft',
      scope: scope(),
      revision: 1,
      docId: 'old-document',
      update: Y.encodeStateAsUpdate(old),
    });
    const remote = transport();

    await expect(synchronize(remote.client)).rejects.toThrow();

    expect(remote.uploads).toEqual([]);
    expect(await readDrafts(scope())).toHaveLength(1);
    expect(bodyCacheSealed(scope())).toBe(true);
  });

  it('seals a body whose identity changes between download pages while retaining pending work', async () => {
    const server = document('Base');
    const editing = document();
    Y.applyUpdate(editing, Y.encodeStateAsUpdate(server));
    await cache(server);
    await pending(editing);
    const checkpoint = base64(Y.encodeStateAsUpdate(server));
    const before = Y.encodeStateVector(server);
    server.getText('body').insert(4, ' remote edit');
    const first = base64(Y.encodeStateAsUpdate(server, before));
    const secondVector = Y.encodeStateVector(server);
    server.getText('body').insert(server.getText('body').length, ' more remote text');
    const second = base64(Y.encodeStateAsUpdate(server, secondVector));
    const remote = transport(server, {
      getPage: (_request, count) =>
        count === 1
          ? page(server, {
              headSeq: '12',
              checkpoint: { seq: '10', update: checkpoint },
              updates: [{ seq: '11', update: first }],
              hasMore: true,
            })
          : {
              docId: REPLACEMENT_DOC_ID,
              headSeq: '12',
              schemaVersion: SCHEMA_VERSION,
              canWrite: true,
              updates: [{ seq: '12', update: second }],
              hasMore: false,
            },
    });

    await expect(synchronize(remote.client)).rejects.toThrow(/body changed/iu);

    expect(remote.gets).toHaveLength(2);
    expect(remote.uploads).toEqual([]);
    expect(await readDrafts(scope())).toHaveLength(1);
    expect(bodyCacheSealed(scope())).toBe(true);
    expect(await readBodyCache(scope())).toBeNull();
  });

  it('seals a document-changed upload refusal without acknowledging its pending edit', async () => {
    const server = document('Base');
    const editing = document();
    Y.applyUpdate(editing, Y.encodeStateAsUpdate(server));
    await cache(server);
    await pending(editing);
    const remote = transport(server, {
      postRefusal: { status: 409, code: 'document_changed' },
    });

    await expect(synchronize(remote.client)).rejects.toThrow(/body changed/iu);

    expect(remote.gets).toHaveLength(1);
    expect(remote.uploads).toHaveLength(1);
    expect(server.getText('body').toJSON()).toBe('Base');
    expect(await readDrafts(scope())).toHaveLength(1);
    expect(bodyCacheSealed(scope())).toBe(true);
    expect(await readBodyCache(scope())).toBeNull();
  });

  it('seals a replacement identity in the upload receipt and preserves pending work', async () => {
    const server = document('Base');
    const editing = document();
    Y.applyUpdate(editing, Y.encodeStateAsUpdate(server));
    await cache(server);
    await pending(editing);
    const remote = transport(server, { postDocId: REPLACEMENT_DOC_ID });

    await expect(synchronize(remote.client)).rejects.toThrow(/body changed/iu);

    expect(remote.gets).toHaveLength(1);
    expect(remote.uploads).toHaveLength(1);
    expect(await readDrafts(scope())).toHaveLength(1);
    expect(bodyCacheSealed(scope())).toBe(true);
    expect(await readBodyCache(scope())).toBeNull();
  });

  it('seals a replacement identity in the confirmation download without acknowledging work', async () => {
    const server = document('Base');
    const editing = document();
    Y.applyUpdate(editing, Y.encodeStateAsUpdate(server));
    await cache(server);
    await pending(editing);
    const remote = transport(server, {
      getPage: (_request, count) =>
        page(server, { docId: count === 1 ? DOC_ID : REPLACEMENT_DOC_ID }),
    });

    await expect(synchronize(remote.client)).rejects.toThrow(/body changed/iu);

    expect(remote.gets).toHaveLength(2);
    expect(remote.uploads).toHaveLength(1);
    expect(await readDrafts(scope())).toHaveLength(1);
    expect(bodyCacheSealed(scope())).toBe(true);
    expect(await readBodyCache(scope())).toBeNull();
  });

  it('admits the complete local body only through its publication receipt draft', async () => {
    const local = document('New note written offline');
    await writeDraft({
      id: `${scope()}:published-local`,
      scope: scope(),
      revision: 0,
      docId: `local:${ITEM}`,
      update: Y.encodeStateAsUpdate(local),
    });
    const remote = transport(document());

    await synchronize(remote.client);

    expect(remote.server.getText('body').toJSON()).toBe('New note written offline');
    expect(remote.uploads).toHaveLength(1);
    expect(await readDrafts(scope())).toEqual([]);
    expect((await readBodyCache(scope()))?.docId).toBe(DOC_ID);
  });

  it('refuses an unreceipted local document identity without sending its body', async () => {
    await writeDraft({
      id: `${scope()}:unreceipted`,
      scope: scope(),
      revision: 0,
      docId: `local:${ITEM}`,
      update: Y.encodeStateAsUpdate(document('Unverified local body')),
    });
    const remote = transport();

    await expect(synchronize(remote.client)).rejects.toThrow();

    expect(remote.uploads).toEqual([]);
    expect(await readDrafts(scope())).toHaveLength(1);
    expect(bodyCacheSealed(scope())).toBe(true);
  });

  it('preserves read-only pending work and calls the access-change callback', async () => {
    const server = document('Base');
    const editing = document();
    Y.applyUpdate(editing, Y.encodeStateAsUpdate(server));
    await cache(server);
    await pending(editing);
    server.getText('body').insert(4, ' newer server content');
    const onReadOnly = vi.fn(() => Promise.resolve());
    const remote = transport(server, { canWrite: false });

    await expect(synchronize(remote.client, document(), { onReadOnly })).rejects.toThrow(
      /read.only/iu,
    );

    expect(onReadOnly).toHaveBeenCalledOnce();
    expect(remote.uploads).toEqual([]);
    expect(await readDrafts(scope())).toHaveLength(1);
    const saved = await readBodyCache(scope());
    if (saved === null) throw new Error('Missing readable remote body.');
    const reopened = document();
    Y.applyUpdate(reopened, saved.update);
    expect(reopened.getText('body').toJSON()).toBe('Base newer server content');
    expect(server.getText('body').toJSON()).toBe('Base newer server content');
  });

  it('reports read-only access before refusing an outdated document identity', async () => {
    await cache(document('Old body'), 'old-document');
    await writeDraft({
      id: `${scope()}:old-draft`,
      scope: scope(),
      revision: 0,
      docId: 'old-document',
      update: Y.encodeStateAsUpdate(document('Old pending work')),
    });
    const onReadOnly = vi.fn(() => Promise.resolve());
    const remote = transport(document('New body'), { canWrite: false });

    await expect(synchronize(remote.client, document(), { onReadOnly })).rejects.toThrow();

    expect(onReadOnly).toHaveBeenCalledOnce();
    expect(remote.uploads).toEqual([]);
    expect(await readDrafts(scope())).toHaveLength(1);
    expect(bodyCacheSealed(scope())).toBe(true);
  });

  it('recovers readable content after a write refusal without acknowledging its pending edit', async () => {
    const server = document('Base');
    const editing = document();
    Y.applyUpdate(editing, Y.encodeStateAsUpdate(server));
    await cache(server);
    await pending(editing);
    const onReadOnly = vi.fn(() => Promise.resolve());
    const remote = transport(server, {
      postRefusal: { status: 403, code: 'item.forbidden' },
      getPage: (_request, count) => page(server, { canWrite: count === 1 }),
    });

    const outcome: unknown = await synchronize(remote.client, document(), { onReadOnly }).catch(
      (cause: unknown) => cause,
    );

    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toMatchObject({ status: 403 });
    expect(onReadOnly).toHaveBeenCalledOnce();
    expect(remote.gets).toHaveLength(2);
    expect(remote.uploads).toHaveLength(1);
    expect(await readDrafts(scope())).toHaveLength(1);
    expect((await readBodyCache(scope()))?.docId).toBe(DOC_ID);
    expect(server.getText('body').toJSON()).toBe('Base');
    const saved = await readBodyCache(scope());
    if (saved === null) throw new Error('Missing readable remote body.');
    const reopened = document();
    Y.applyUpdate(reopened, saved.update);
    expect(reopened.getText('body').toJSON()).toBe('Base');
  });

  it('keeps the journal if the confirmation download reports read-only access', async () => {
    const server = document('Base');
    const editing = document();
    Y.applyUpdate(editing, Y.encodeStateAsUpdate(server));
    await cache(server);
    await pending(editing);
    const onReadOnly = vi.fn(() => Promise.resolve());
    const remote = transport(server, {
      getPage: (_request, count) => page(server, { canWrite: count === 1 }),
    });

    await expect(synchronize(remote.client, document(), { onReadOnly })).rejects.toThrow(
      /read.only|pending/iu,
    );

    expect(onReadOnly).toHaveBeenCalledOnce();
    expect(remote.gets).toHaveLength(2);
    expect(remote.uploads).toHaveLength(1);
    expect(await readDrafts(scope())).toHaveLength(1);
    const saved = await readBodyCache(scope());
    if (saved === null) throw new Error('Missing readable remote body.');
    const reopened = document();
    Y.applyUpdate(reopened, saved.update);
    expect(reopened.getText('body').toJSON()).toBe('Base offline edit');
  });

  it.each([
    { status: 401, code: 'auth.unauthenticated' },
    { status: 403, code: 'auth.principal_inactive' },
  ])('propagates $code without replacing it with read-only recovery', async (refusal) => {
    const server = document('Base');
    const editing = document();
    Y.applyUpdate(editing, Y.encodeStateAsUpdate(server));
    await cache(server);
    await pending(editing);
    const onReadOnly = vi.fn(() => Promise.resolve());
    const remote = transport(server, { postRefusal: refusal });

    await expect(synchronize(remote.client, document(), { onReadOnly })).rejects.toMatchObject(
      refusal,
    );

    expect(onReadOnly).not.toHaveBeenCalled();
    expect(remote.gets).toHaveLength(1);
    expect(await readDrafts(scope())).toHaveLength(1);
  });

  it('downloads and caches a read-only note that has no pending edits', async () => {
    const remote = transport(document('Readable offline'), { canWrite: false });
    const local = document();

    await expect(synchronize(remote.client, local)).resolves.toEqual({
      docId: DOC_ID,
      canWrite: false,
    });

    expect(local.getText('body').toJSON()).toBe('Readable offline');
    expect(remote.uploads).toEqual([]);
    expect(await readBodyCache(scope())).not.toBeNull();
  });

  it('retains pending edits after a committed upload loses its response and safely retries', async () => {
    const server = document('Base');
    const editing = document();
    Y.applyUpdate(editing, Y.encodeStateAsUpdate(server));
    await cache(server);
    await pending(editing);
    let lost = true;
    const remote = transport(server, {
      onPost: () => {
        if (lost) {
          lost = false;
          return Promise.reject(new TypeError('Upload response lost'));
        }
        return Promise.resolve();
      },
    });

    await expect(synchronize(remote.client)).rejects.toThrow();
    expect(await readDrafts(scope())).toHaveLength(1);
    await synchronize(remote.client);

    expect(server.getText('body').toJSON()).toBe('Base offline edit');
    expect(await readDrafts(scope())).toEqual([]);
    const saved = await readBodyCache(scope());
    if (saved === null) throw new Error('The confirmed note was not retained.');
    const reopened = document();
    Y.applyUpdate(reopened, saved.update);
    expect(reopened.getText('body').toJSON()).toBe('Base offline edit');
  });

  it('preserves a later draft revision and incorporates remote edits after an upload', async () => {
    const server = document('Base');
    const editing = document();
    Y.applyUpdate(editing, Y.encodeStateAsUpdate(server));
    await cache(server);
    const journal = await pending(editing, ' first edit');
    const earlier = await readDrafts(scope());
    const remote = transport(server, {
      onPost: async () => {
        const before = Y.encodeStateVector(editing);
        editing.getText('body').insert(editing.getText('body').length, ' later edit');
        journal.append(Y.encodeStateAsUpdate(editing, before));
        await journal.snapshot();
        server.getText('body').insert(server.getText('body').length, ' remote edit');
      },
    });
    const synchronized = document();

    await synchronize(remote.client, synchronized);

    expect(synchronized.getText('body').toJSON()).toContain('first edit');
    expect(synchronized.getText('body').toJSON()).toContain('remote edit');
    const retained = await readDrafts(scope());
    expect(retained).toHaveLength(1);
    expect(retained[0]?.revision).toBeGreaterThan(earlier[0]?.revision ?? 0);
    const saved = await readBodyCache(scope());
    if (saved === null) throw new Error('Missing confirmed body.');
    const reopened = document();
    Y.applyUpdate(reopened, saved.update);
    for (const record of retained) Y.applyUpdate(reopened, record.update);
    expect(reopened.getText('body').toJSON()).toContain('later edit');
    expect(reopened.getText('body').toJSON()).toContain('remote edit');
  });

  it('does not acknowledge pending edits when the complete cache write fails', async () => {
    const server = document('Base');
    const editing = document();
    Y.applyUpdate(editing, Y.encodeStateAsUpdate(server));
    await cache(server);
    await pending(editing);
    const remote = transport(server);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Called below with the actual object store receiver.
    const originalPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (this.name === 'bodies') throw new DOMException('Quota exceeded', 'QuotaExceededError');
      return originalPut.call(this, value, key);
    });

    await expect(synchronize(remote.client)).rejects.toThrow(/cache write aborted/iu);

    expect(remote.uploads).toHaveLength(1);
    expect(await readDrafts(scope())).toHaveLength(1);
  });
});
