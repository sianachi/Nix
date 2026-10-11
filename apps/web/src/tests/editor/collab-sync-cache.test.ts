import 'fake-indexeddb/auto';
import { SCHEMA_VERSION } from '@nix/editor-schema';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BodyCacheRecord, BodyCacheStore } from '../../editor/body-cache';
import {
  flushLocalDraftsForScope,
  flushLocalDraftsForAccount,
  startCollabSync,
  type ProviderSocket,
  type SyncState,
} from '../../editor/collab-sync';
import {
  bodyCacheAdmits,
  bodyCacheAccountEpoch,
  clearBodyCache,
  indexedBodyCache,
  openBodyCache,
  onBodyForgetting,
  readBodyCache,
  sealBodyCache,
  sealAccountBodies,
  reopenRefusedItemBodies,
  writeBodyCache,
} from '../../editor/body-cache';
import { clearDrafts, listDraftScopes, readDrafts, writeDraft } from '../../editor/draft-journal';

/**
 * The local copy's promises: it paints before the connection opens without being sent back as an
 * edit, it is refreshed only from a state the server has confirmed, and it is dropped whenever the
 * server says this device may no longer read the body or the copy belongs to another document.
 */

const MESSAGE_SYNC = 0;
const SCOPE = JSON.stringify(['person-1', 'workspace-1', 'item-1', 'note']);

class FakeSocket implements ProviderSocket {
  binaryType = 'blob';
  readyState = 0;
  readonly sent: (string | Uint8Array)[] = [];
  closedWith: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closedWith = code ?? 1000;
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1000 });
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  ready(docId = 'doc-1', mode = 'write'): void {
    this.onmessage?.({
      data: JSON.stringify({ type: 'ready', docId, mode, bodyKind: 'note' }),
    });
  }

  receiveStep2(server: Y.Doc): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep2(encoder, server);
    const bytes = encoding.toUint8Array(encoder);
    this.onmessage?.({
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
  }

  drop(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  binaryFrames(): Uint8Array[] {
    return this.sent.filter((frame): frame is Uint8Array => typeof frame !== 'string');
  }

  acknowledgeBarrier(): void {
    const frame = this.binaryFrames().find((bytes) => bytes[0] === 3);
    if (frame === undefined) throw new Error('No persistence barrier was sent.');
    this.sent.splice(this.sent.indexOf(frame), 1);
    this.onmessage?.({ data: frame });
  }
}

function memoryCache(initial?: BodyCacheRecord): BodyCacheStore & {
  readonly records: Map<string, BodyCacheRecord>;
  readonly discarded: string[];
} {
  const records = new Map<string, BodyCacheRecord>();
  if (initial) records.set(initial.scope, initial);
  const discarded: string[] = [];
  return {
    records,
    discarded,
    read: (scope) => Promise.resolve(records.get(scope) ?? null),
    write: (record) => {
      records.set(record.scope, record);
      return Promise.resolve();
    },
    discard: (scope) => {
      discarded.push(scope);
      records.delete(scope);
      return Promise.resolve();
    },
  };
}

function docWith(text: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText('body').insert(0, text);
  return doc;
}

function recordOf(doc: Y.Doc, overrides: Partial<BodyCacheRecord> = {}): BodyCacheRecord {
  return {
    scope: SCOPE,
    docId: 'doc-1',
    schemaVersion: SCHEMA_VERSION,
    savedAt: 1,
    update: Y.encodeStateAsUpdate(doc),
    ...overrides,
  };
}

function start(
  cache: BodyCacheStore,
  doc = new Y.Doc(),
  options: {
    draftScope?: string;
    offline?: boolean;
    getAccessToken?: (forceRefresh?: boolean) => Promise<string | null>;
  } = {},
) {
  const sockets: FakeSocket[] = [];
  const states: SyncState[] = [];
  const notices: string[] = [];
  const localCopy = vi.fn();
  const sync = startCollabSync({
    ...options,
    onLocalCopy: localCopy,
    itemId: 'item-1',
    doc,
    fragmentName: 'default',
    cacheScope: SCOPE,
    bodyCache: cache,
    getAccessToken: options.getAccessToken ?? (() => Promise.resolve('token')),
    onState: (state) => {
      states.push(state);
    },
    onNotice: ({ code }) => {
      notices.push(code);
    },
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    minRetryMs: 10,
    maxRetryMs: 40,
  });
  const latest = (): FakeSocket => {
    const socket = sockets.at(-1);
    if (!socket) throw new Error('No socket was created.');
    return socket;
  };
  return { doc, sync, sockets, states, notices, latest, localCopy };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('durable offline notes', () => {
  beforeEach(async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      get length() {
        return values.size;
      },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    await clearBodyCache();
    await clearDrafts();
    await openBodyCache('person-1');
  });

  it('drains every mounted provider belonging to the initiating account before draft inventory', async () => {
    const cache = memoryCache(recordOf(docWith('Saved')));
    const first = start(cache, new Y.Doc(), { draftScope: SCOPE, offline: true });
    const second = start(cache, new Y.Doc(), { draftScope: SCOPE, offline: true });
    const otherScope = JSON.stringify(['person-10', 'workspace-1', 'item-1', 'note']);
    const other = start(cache, new Y.Doc(), { draftScope: otherScope, offline: true });
    const unrelated = vi
      .spyOn(other.sync, 'flushLocal')
      .mockRejectedValue(new Error('Other account'));
    await Promise.all([first.sync.flushLocal(), second.sync.flushLocal()]);
    first.doc.getText('body').insert(5, ' first');
    second.doc.getText('body').insert(5, ' second');
    await flushLocalDraftsForAccount('person-1');
    expect(await readDrafts(SCOPE)).toHaveLength(2);
    expect(unrelated).not.toHaveBeenCalled();
    for (const run of [first, second, other]) run.sync.destroy();
    unrelated.mockRestore();
  });

  it('propagates an account provider flush failure before sign-out can inventory drafts', async () => {
    const run = start(memoryCache(recordOf(docWith('Saved'))), new Y.Doc(), {
      draftScope: SCOPE,
      offline: true,
    });
    await run.sync.flushLocal();
    const failed = vi
      .spyOn(run.sync, 'flushLocal')
      .mockRejectedValue(new Error('Draft storage failed'));
    await expect(flushLocalDraftsForAccount('person-1')).rejects.toThrow('Draft storage failed');
    failed.mockRestore();
    run.sync.destroy();
  });

  it('reopens confirmed text and pending edits before any connection, including after another close', async () => {
    const cache = memoryCache();
    const confirmed = new Y.Doc();
    const first = docWith('Saved');
    const original = Y.encodeStateAsUpdate(first);
    const before = Y.encodeStateVector(first);
    first.getText('body').insert(5, ' offline');
    cache.records.set(SCOPE, { ...recordOf(first), update: original });
    await writeDraft({
      id: 'saved-edit',
      scope: SCOPE,
      revision: 1,
      docId: 'doc-1',
      update: Y.encodeStateAsUpdate(first, before),
    });
    const run = start(cache, confirmed, { draftScope: SCOPE, offline: true });
    await run.sync.flushLocal();
    expect(run.doc.getText('body').toJSON()).toBe('Saved offline');
    expect(run.sockets).toHaveLength(0);
    run.doc.getText('body').insert(13, ' again');
    await run.sync.flushLocal();
    run.sync.destroy();
    const reopened = start(cache, new Y.Doc(), { draftScope: SCOPE, offline: true });
    await reopened.sync.flushLocal();
    expect(reopened.doc.getText('body').toJSON()).toBe('Saved offline again');
    reopened.sync.destroy();
    first.destroy();
  });

  it('retains a draft but sends no document bytes when its cache is gone and the server identity changed', async () => {
    await writeDraft({
      id: 'old-edit',
      scope: SCOPE,
      revision: 1,
      docId: 'old-doc',
      update: Y.encodeStateAsUpdate(docWith('Older offline draft')),
    });
    const run = start(memoryCache(), new Y.Doc(), { draftScope: SCOPE });
    await vi.waitFor(() => {
      expect(run.sockets).toHaveLength(1);
    });
    const socket = run.latest();
    socket.open();
    socket.ready('new-doc');
    expect(socket.binaryFrames()).toHaveLength(0);
    expect(run.notices).toContain('local_copy_stale');
    expect(await readDrafts(SCOPE)).toHaveLength(1);
    run.sync.destroy();
  });

  it('keeps journaled edits until the confirmed cache write commits, and preserves them when it fails', async () => {
    const original = docWith('Saved');
    const cache = memoryCache(recordOf(original));
    const run = start(cache, new Y.Doc(), { draftScope: SCOPE });
    await vi.waitFor(() => {
      expect(run.sockets).toHaveLength(1);
    });
    const socket = run.latest();
    socket.open();
    socket.ready();
    socket.receiveStep2(original);
    run.doc.getText('body').insert(5, ' edit');
    await run.sync.flushLocal();
    let rejectWrite: ((reason: Error) => void) | undefined;
    cache.write = () =>
      new Promise<void>((_, reject) => {
        rejectWrite = reject;
      });
    const completion = run.sync.syncAndCache();
    const rejected = expect(completion).rejects.toThrow('Quota exceeded');
    await vi.waitFor(() => {
      expect(socket.binaryFrames().some((frame) => frame[0] === 3)).toBe(true);
    });
    socket.acknowledgeBarrier();
    await vi.waitFor(() => {
      expect(rejectWrite).toBeDefined();
    });
    expect(await readDrafts(SCOPE)).toHaveLength(1);
    rejectWrite?.(new Error('Quota exceeded'));
    await rejected;
    expect(await readDrafts(SCOPE)).toHaveLength(1);
    run.sync.destroy();
  });

  it('confirms an edit made while the earlier journal snapshot is being read', async () => {
    const original = docWith('Saved');
    const cache = memoryCache(recordOf(original));
    const run = start(cache, new Y.Doc(), { draftScope: SCOPE });
    try {
      await vi.waitFor(() => {
        expect(run.sockets).toHaveLength(1);
      });
      const socket = run.latest();
      socket.open();
      socket.ready();
      socket.receiveStep2(original);
      run.doc.getText('body').insert(5, ' first');
      await run.sync.flushLocal();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Called below with the actual index receiver.
      const getAll = IDBIndex.prototype.getAll;
      let reads = 0;
      vi.spyOn(IDBIndex.prototype, 'getAll').mockImplementation(function (
        this: IDBIndex,
        query?: IDBValidKey | IDBKeyRange | null,
        count?: number,
      ) {
        const request = getAll.call(this, query, count);
        if (this.name === 'scope' && ++reads === 2)
          request.addEventListener('success', () => {
            run.doc.getText('body').insert(run.doc.getText('body').length, ' later');
          });
        return request;
      });
      const send = socket.send.bind(socket);
      vi.spyOn(socket, 'send').mockImplementation((data) => {
        send(data);
        if (typeof data !== 'string' && data[0] === 3)
          queueMicrotask(() => {
            socket.acknowledgeBarrier();
          });
      });

      await run.sync.syncAndCache();

      expect(await readDrafts(SCOPE)).toEqual([]);
      const retained = cache.records.get(SCOPE);
      if (retained === undefined) throw new Error('The confirmed note was not retained.');
      const reopened = new Y.Doc();
      try {
        Y.applyUpdate(reopened, retained.update);
        expect(reopened.getText('body').toJSON()).toBe('Saved first later');
      } finally {
        reopened.destroy();
      }
    } finally {
      run.sync.destroy();
      vi.restoreAllMocks();
    }
  });

  it('downloads a read-only note without replying with local document bytes', async () => {
    const cache = memoryCache();
    const run = start(cache);
    await flush();
    const socket = run.latest();
    socket.open();
    socket.ready('doc-1', 'read');
    const server = docWith('Read-only text');
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, server);
    socket.onmessage?.({ data: encoding.toUint8Array(encoder) });
    socket.receiveStep2(server);
    const completion = run.sync.syncAndCache();
    await vi.waitFor(() => {
      expect(socket.binaryFrames().some((frame) => frame[0] === 3)).toBe(true);
    });
    socket.acknowledgeBarrier();
    await completion;
    const syncKinds = socket
      .binaryFrames()
      .filter((frame) => frame[0] === MESSAGE_SYNC)
      .map((frame) => decoding.readVarUint(decoding.createDecoder(frame.subarray(1))));
    expect(syncKinds).toEqual([syncProtocol.messageYjsSyncStep1]);
    expect(cache.records.get(SCOPE)?.docId).toBe('doc-1');
    run.sync.destroy();
  });

  it('cancels a download waiting for the initial server state', async () => {
    const run = start(memoryCache());
    const controller = new AbortController();
    const completion = run.sync.syncAndCache(controller.signal);
    const rejected = expect(completion).rejects.toThrow('cancelled');
    controller.abort();
    await rejected;
    run.sync.destroy();
  });

  it.each([4403, 4404, 4405])(
    'refuses a stale IndexedDB writer after server refusal %i and retains queued owner edits',
    async (code) => {
      const saved = docWith('Saved');
      await writeBodyCache(recordOf(saved));
      const refused = start(indexedBodyCache, new Y.Doc(), { draftScope: SCOPE });
      const stale = start(indexedBodyCache);
      await vi.waitFor(() => {
        expect(refused.sockets).toHaveLength(1);
        expect(stale.sockets).toHaveLength(1);
      });
      refused.latest().open();
      refused.latest().ready();
      refused.latest().receiveStep2(saved);
      stale.latest().open();
      stale.latest().ready();
      stale.latest().receiveStep2(saved);
      refused.doc.getText('body').insert(5, ' pending');
      refused.latest().drop(code);

      expect(bodyCacheAdmits(SCOPE)).toBe(false);
      await refused.sync.flushLocal();
      expect(await listDraftScopes('person-1')).toEqual([SCOPE]);
      expect(await readDrafts(SCOPE)).toHaveLength(1);
      saved.getText('body').insert(5, ' stale confirmed');
      stale.latest().receiveStep2(saved);
      stale.sync.destroy();
      await writeBodyCache(recordOf(saved));
      expect(await readBodyCache(SCOPE)).toBeNull();
      const rawCopy = await new Promise<unknown>((resolve, reject) => {
        const request = indexedDB.open('nix-document-cache', 1);
        request.onerror = () => {
          reject(request.error ?? new Error('Could not open the cache for verification.'));
        };
        request.onsuccess = () => {
          const db = request.result;
          const read = db.transaction('bodies', 'readonly').objectStore('bodies').get(SCOPE);
          read.onerror = () => {
            reject(read.error ?? new Error('Could not read the cache for verification.'));
          };
          read.onsuccess = () => {
            db.close();
            resolve(read.result);
          };
        };
      });
      expect(rawCopy).toBeUndefined();
      const reopened = start(indexedBodyCache, new Y.Doc(), {
        draftScope: SCOPE,
        offline: true,
      });
      await expect(reopened.sync.flushLocal()).rejects.toThrow('Access to this note was refused');
      expect(reopened.doc.getText('body').toJSON()).toBe('');
      expect(reopened.localCopy).not.toHaveBeenCalled();
      reopened.sync.destroy();
      if (code !== 4405) {
        reopenRefusedItemBodies('person-1', 'workspace-1', 'item-1');
        expect(bodyCacheAdmits(SCOPE)).toBe(true);
        await expect(stale.sync.syncAndCache()).rejects.toThrow();
        expect(await readBodyCache(SCOPE)).toBeNull();
        const restoredAccess = start(indexedBodyCache);
        await vi.waitFor(() => {
          expect(restoredAccess.sockets).toHaveLength(1);
        });
        restoredAccess.latest().open();
        restoredAccess.latest().ready();
        restoredAccess.latest().receiveStep2(saved);
        const completion = restoredAccess.sync.syncAndCache();
        await vi.waitFor(() => {
          expect(
            restoredAccess
              .latest()
              .binaryFrames()
              .some((frame) => frame[0] === 3),
          ).toBe(true);
        });
        restoredAccess.latest().acknowledgeBarrier();
        await completion;
        expect(await readBodyCache(SCOPE)).not.toBeNull();
        restoredAccess.sync.destroy();
      }
      refused.sync.destroy();
      saved.destroy();
    },
  );

  it('preserves confirmed bodies and pending edits through token expiry and resumes durable sync', async () => {
    const server = docWith('Saved');
    await writeBodyCache(recordOf(server));
    const getAccessToken = vi.fn((forceRefresh = false) =>
      Promise.resolve(forceRefresh ? 'fresh-token' : 'cached-token'),
    );
    const run = start(indexedBodyCache, new Y.Doc(), { draftScope: SCOPE, getAccessToken });
    try {
      await vi.waitFor(() => {
        expect(run.sockets).toHaveLength(1);
      });
      const original = run.latest();
      original.open();
      original.ready();
      original.receiveStep2(server);
      expect(run.doc.getText('body').toJSON()).toBe('Saved');
      run.doc.getText('body').insert(5, ' pending');
      await run.sync.flushLocal();
      const pending = await readDrafts(SCOPE);
      const confirmed = await readBodyCache(SCOPE);
      expect(pending).toHaveLength(1);
      expect(confirmed).not.toBeNull();

      original.drop(4401);

      expect(bodyCacheAdmits(SCOPE)).toBe(true);
      expect(await readBodyCache(SCOPE)).toEqual(confirmed);
      expect(await readDrafts(SCOPE)).toEqual(pending);
      expect(run.notices).not.toContain('access_revoked');
      await vi.waitFor(() => {
        expect(run.sockets).toHaveLength(2);
      });
      expect(getAccessToken).toHaveBeenCalledWith(true);
      const renewed = run.latest();
      renewed.open();
      expect(renewed.sent[0]).toBe(
        JSON.stringify({ type: 'auth', token: 'fresh-token', schemaVersion: SCHEMA_VERSION }),
      );
      renewed.ready();
      const serverStep1 = encoding.createEncoder();
      encoding.writeVarUint(serverStep1, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(serverStep1, server);
      renewed.onmessage?.({ data: encoding.toUint8Array(serverStep1) });
      renewed.receiveStep2(server);

      const retainConfirmedEdits = async (): Promise<void> => {
        const completion = run.sync.syncAndCache();
        for (let barrier = 0; barrier < 2; barrier += 1) {
          await vi.waitFor(() => {
            expect(renewed.binaryFrames().some((frame) => frame[0] === 3)).toBe(true);
          });
          for (const frame of renewed.binaryFrames()) {
            const decoder = decoding.createDecoder(frame);
            if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) continue;
            const kind = decoding.readVarUint(decoder);
            if (kind === syncProtocol.messageYjsSyncStep2 || kind === syncProtocol.messageYjsUpdate)
              Y.applyUpdate(server, decoding.readVarUint8Array(decoder));
          }
          renewed.acknowledgeBarrier();
        }
        await completion;
      };
      await retainConfirmedEdits();
      expect(server.getText('body').toJSON()).toBe('Saved pending');
      expect(await readDrafts(SCOPE)).toEqual([]);
      const resumed = await readBodyCache(SCOPE);
      if (resumed === null) throw new Error('Missing confirmed body after renewal.');
      const reopened = new Y.Doc();
      Y.applyUpdate(reopened, resumed.update);
      expect(reopened.getText('body').toJSON()).toBe('Saved pending');
      reopened.destroy();

      run.doc.getText('body').insert(run.doc.getText('body').length, ' later');
      await run.sync.flushLocal();
      expect(await readDrafts(SCOPE)).toHaveLength(1);
      await retainConfirmedEdits();
      expect(server.getText('body').toJSON()).toBe('Saved pending later');
      expect(await readDrafts(SCOPE)).toEqual([]);
      const savedLater = await readBodyCache(SCOPE);
      if (savedLater === null) throw new Error('Missing later confirmed body after renewal.');
      const reopenedLater = new Y.Doc();
      Y.applyUpdate(reopenedLater, savedLater.update);
      expect(reopenedLater.getText('body').toJSON()).toBe('Saved pending later');
      reopenedLater.destroy();
      expect(bodyCacheAdmits(SCOPE)).toBe(true);
      expect(run.notices).not.toContain('access_revoked');
      expect(run.states.at(-1)).toBe('live');
    } finally {
      run.sync.destroy();
      run.doc.destroy();
      server.destroy();
    }
  });

  it('ignores a delayed refusal event after fresh item authorization reopens its fence', async () => {
    await sealBodyCache(SCOPE);
    const key =
      'nix.body-cache.sealed-item.' + JSON.stringify(['person-1', 'workspace-1', 'item-1']);
    const refusedValue = localStorage.getItem(key);
    reopenRefusedItemBodies('person-1', 'workspace-1', 'item-1');
    await writeBodyCache(recordOf(docWith('Restored')));
    const reopened = start(indexedBodyCache, new Y.Doc(), { offline: true });
    await reopened.sync.flushLocal();
    window.dispatchEvent(
      new StorageEvent('storage', { key, oldValue: null, newValue: refusedValue }),
    );
    expect(bodyCacheAdmits(SCOPE)).toBe(true);
    expect(reopened.notices).not.toContain('body_access_unavailable');
    await reopened.sync.flushLocal();
    expect(reopened.doc.getText('body').toJSON()).toBe('Restored');
    reopened.sync.destroy();
  });

  it('closes mounted providers on account refusal while preserving pending owner edits', async () => {
    const saved = docWith('Saved');
    await writeBodyCache(recordOf(saved));
    const editing = start(indexedBodyCache, new Y.Doc(), { draftScope: SCOPE });
    const otherTab = start(indexedBodyCache);
    await vi.waitFor(() => {
      expect(editing.sockets).toHaveLength(1);
      expect(otherTab.sockets).toHaveLength(1);
    });
    for (const run of [editing, otherTab]) {
      run.latest().open();
      run.latest().ready();
      run.latest().receiveStep2(saved);
    }
    editing.doc.getText('body').insert(5, ' pending');
    const closure = sealAccountBodies('person-1', bodyCacheAccountEpoch('person-1'));
    expect(bodyCacheAdmits(SCOPE)).toBe(false);
    expect(editing.notices).toContain('body_access_unavailable');
    expect(otherTab.notices).toContain('body_access_unavailable');
    expect(otherTab.states.at(-1)).toBe('readonly');
    await editing.sync.flushLocal();
    await closure;
    expect(await readDrafts(SCOPE)).toHaveLength(1);
    expect(await listDraftScopes('person-1')).toEqual([SCOPE]);
    expect(await readBodyCache(SCOPE)).toBeNull();
    const reopenedDoc = new Y.Doc();
    const reopened = startCollabSync({
      itemId: 'item-1',
      doc: reopenedDoc,
      fragmentName: 'default',
      draftScope: SCOPE,
      offline: true,
      getAccessToken: () => Promise.resolve(null),
      onState: () => undefined,
    });
    await expect(reopened.flushLocal()).rejects.toThrow('Access to this note was refused');
    expect(reopenedDoc.getText('body').toJSON()).toBe('');
    reopened.destroy();
    editing.sync.destroy();
    otherTab.sync.destroy();
    saved.destroy();
    reopenedDoc.destroy();
  });

  it('refuses an old provider acknowledgement when the same account lifecycle changes without an event', async () => {
    const saved = docWith('Saved');
    await writeBodyCache(recordOf(saved));
    const stale = start(indexedBodyCache, new Y.Doc(), { draftScope: SCOPE });
    await vi.waitFor(() => {
      expect(stale.sockets).toHaveLength(1);
    });
    stale.latest().open();
    stale.latest().ready();
    stale.latest().receiveStep2(saved);
    stale.doc.getText('body').insert(5, ' pending');
    await stale.sync.flushLocal();
    const completion = stale.sync.syncAndCache();
    const refused = expect(completion).rejects.toThrow();
    await vi.waitFor(() => {
      expect(
        stale
          .latest()
          .binaryFrames()
          .some((frame) => frame[0] === 3),
      ).toBe(true);
    });
    // Another tab reauthenticates before its storage event reaches this provider.
    localStorage.setItem('nix.body-cache.epoch.' + JSON.stringify('person-1'), crypto.randomUUID());
    stale.latest().acknowledgeBarrier();
    await refused;
    expect(stale.notices).toContain('body_access_unavailable');
    expect(await readDrafts(SCOPE)).toHaveLength(1);
    const copy = await readBodyCache(SCOPE);
    const restored = new Y.Doc();
    if (copy !== null) Y.applyUpdate(restored, copy.update);
    expect(restored.getText('body').toJSON()).toBe('Saved');
    stale.sync.destroy();
    saved.destroy();
    restored.destroy();
  });

  it('does not replay sealed recovery edits when confirmed-body caching is disabled', async () => {
    await writeDraft({
      id: 'recover-only',
      scope: SCOPE,
      revision: 1,
      docId: 'doc-1',
      update: Y.encodeStateAsUpdate(docWith('Recovery bytes')),
    });
    await sealBodyCache(SCOPE);
    const doc = new Y.Doc();
    const sync = startCollabSync({
      itemId: 'item-1',
      doc,
      fragmentName: 'default',
      draftScope: SCOPE,
      offline: true,
      getAccessToken: () => Promise.resolve(null),
      onState: () => undefined,
    });

    await expect(sync.flushLocal()).rejects.toThrow('Access to this note was refused');
    expect(doc.getText('body').toJSON()).toBe('');
    expect(await listDraftScopes('person-1')).toEqual([SCOPE]);
    sync.destroy();
    doc.destroy();
  });

  it('refuses a cache write already dispatched by an old provider after fresh access reopens', async () => {
    const saved = docWith('Saved');
    await writeBodyCache(recordOf(saved));
    const stale = start(indexedBodyCache);
    await vi.waitFor(() => {
      expect(stale.sockets).toHaveLength(1);
    });
    stale.latest().open();
    stale.latest().ready();
    saved.getText('body').insert(5, ' newer');
    stale.latest().receiveStep2(saved);
    let releaseWrite: (() => Promise<void>) | undefined;
    const originalWrite = indexedBodyCache.write;
    const intercepted = vi.spyOn(indexedBodyCache, 'write').mockImplementationOnce(
      (record, admitted) =>
        new Promise<void>((resolve, reject) => {
          releaseWrite = async () => {
            try {
              await originalWrite(record, admitted);
              resolve();
            } catch (cause) {
              reject(cause instanceof Error ? cause : new Error('The delayed cache write failed.'));
            }
          };
        }),
    );
    stale.sync.destroy();
    expect(releaseWrite).toBeDefined();
    await sealBodyCache(SCOPE);
    reopenRefusedItemBodies('person-1', 'workspace-1', 'item-1');
    expect(bodyCacheAdmits(SCOPE)).toBe(true);
    await releaseWrite?.();

    expect(await readBodyCache(SCOPE)).toBeNull();
    intercepted.mockRestore();
    saved.destroy();
  });

  it('awaits the final durable draft when sealing immediately unmounts its editor', async () => {
    await writeBodyCache(recordOf(docWith('Saved')));
    const run = start(indexedBodyCache, new Y.Doc(), { draftScope: SCOPE, offline: true });
    await run.sync.flushLocal();
    run.doc.getText('body').insert(5, ' last edit');
    const stop = onBodyForgetting((forgetting) => {
      if (forgetting.kind === 'item' && SCOPE.startsWith(forgetting.prefix)) run.sync.destroy();
    });
    const sealing = sealBodyCache(SCOPE);
    await flushLocalDraftsForScope(SCOPE);
    await sealing;

    expect(await readDrafts(SCOPE)).toHaveLength(1);
    expect(await listDraftScopes('person-1')).toEqual([SCOPE]);
    stop();
  });
});

describe('the local body copy', () => {
  it('paints the saved copy before the connection opens and never sends it as a local edit', async () => {
    const cache = memoryCache(recordOf(docWith('Saved text')));
    const run = start(cache);
    await flush();

    expect(run.doc.getText('body').toJSON()).toBe('Saved text');
    expect(run.localCopy).toHaveBeenCalledOnce();
    const socket = run.latest();
    socket.open();
    socket.ready();
    await flush();

    // Only sync step 1 goes out: the copy is the server's own state, not an edit to push.
    const syncFrames = socket.binaryFrames().filter((frame) => frame[0] === MESSAGE_SYNC);
    expect(syncFrames.map((frame) => frame[1])).toEqual([syncProtocol.messageYjsSyncStep1]);
    run.sync.destroy();
  });

  it('refreshes the copy from the server state once the first sync completes', async () => {
    const cache = memoryCache();
    const run = start(cache);
    await flush();
    const socket = run.latest();
    socket.open();
    socket.ready();
    socket.receiveStep2(docWith('From the server'));
    run.sync.destroy();
    await flush();

    const saved = cache.records.get(SCOPE);
    expect(saved?.docId).toBe('doc-1');
    const restored = new Y.Doc();
    Y.applyUpdate(restored, saved?.update ?? new Uint8Array());
    expect(restored.getText('body').toJSON()).toBe('From the server');
  });

  it('does not save a copy that contains an edit the server has not confirmed', async () => {
    const cache = memoryCache();
    const run = start(cache);
    await flush();
    const socket = run.latest();
    socket.open();
    socket.ready();
    socket.receiveStep2(docWith('From the server'));
    run.doc.getText('body').insert(0, 'Unconfirmed ');
    run.sync.destroy();
    await flush();

    expect(cache.records.has(SCOPE)).toBe(false);
  });

  it.each([
    ['revoked', 4403],
    ['not visible to this person', 4404],
    ['locked', 4405],
  ])('drops the copy when access to the body is %s', async (_label, code) => {
    const cache = memoryCache(recordOf(docWith('Saved text')));
    const run = start(cache);
    await flush();
    const socket = run.latest();
    socket.open();
    socket.drop(code);
    await flush();

    expect(cache.discarded).toEqual([SCOPE]);
    run.sync.destroy();
  });

  it('stops without syncing when the copy belongs to a different server document', async () => {
    const cache = memoryCache(recordOf(docWith('Old document')));
    const run = start(cache);
    await flush();
    const socket = run.latest();
    socket.open();
    socket.ready('doc-2');
    await flush();

    expect(socket.binaryFrames()).toHaveLength(0);
    expect(cache.discarded).toEqual([SCOPE]);
    expect(run.notices).toContain('local_copy_stale');
    expect(run.states.at(-1)).toBe('degraded');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(run.sockets).toHaveLength(1);
    run.sync.destroy();
  });

  it('stops, rather than trusting it, when the service does not say which document it joined', async () => {
    const cache = memoryCache(recordOf(docWith('Old document')));
    const run = start(cache);
    await flush();
    const socket = run.latest();
    socket.open();
    socket.onmessage?.({ data: JSON.stringify({ type: 'ready', mode: 'write' }) });
    await flush();

    expect(socket.binaryFrames()).toHaveLength(0);
    expect(run.notices).toContain('local_copy_stale');
    run.sync.destroy();
  });

  it('writes nothing on close when the session made no change worth keeping', async () => {
    const cache = memoryCache();
    const run = start(cache);
    await flush();
    run.sync.destroy();
    await flush();

    expect(cache.records.size).toBe(0);
  });

  it('does not rewrite an unchanged copy just because the document was opened', async () => {
    const saved = docWith('Saved text');
    const cache = memoryCache(recordOf(saved, { savedAt: 1 }));
    const run = start(cache);
    await flush();
    const socket = run.latest();
    socket.open();
    socket.ready();
    socket.receiveStep2(saved);
    run.sync.destroy();
    await flush();

    expect(cache.records.get(SCOPE)?.savedAt).toBe(1);
  });

  it('refreshes the copy once a burst of remote changes goes quiet, not on every change', async () => {
    vi.useFakeTimers();
    const cache = memoryCache();
    const write = vi.spyOn(cache, 'write');
    const run = start(cache);
    await vi.advanceTimersByTimeAsync(0);
    const socket = run.latest();
    socket.open();
    socket.ready();
    const server = docWith('Start');
    socket.receiveStep2(server);
    for (let index = 0; index < 12; index += 1) {
      server.getText('body').insert(0, 'x');
      socket.receiveStep2(server);
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(write).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(write).toHaveBeenCalledOnce();
    run.sync.destroy();
  });

  it('ignores a copy written by a different editor schema', async () => {
    const cache = memoryCache(
      recordOf(docWith('Old schema'), { schemaVersion: SCHEMA_VERSION + 1 }),
    );
    const run = start(cache);
    await flush();

    expect(run.doc.getText('body').toJSON()).toBe('');
    expect(cache.discarded).toEqual([SCOPE]);
    run.sync.destroy();
  });
});
