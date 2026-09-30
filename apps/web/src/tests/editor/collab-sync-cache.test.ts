import { SCHEMA_VERSION } from '@nix/editor-schema';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BodyCacheRecord, BodyCacheStore } from '../../editor/body-cache';
import { startCollabSync, type ProviderSocket, type SyncState } from '../../editor/collab-sync';

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

  ready(docId = 'doc-1'): void {
    this.onmessage?.({
      data: JSON.stringify({ type: 'ready', docId, mode: 'write', bodyKind: 'note' }),
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

function start(cache: BodyCacheStore, doc = new Y.Doc()) {
  const sockets: FakeSocket[] = [];
  const states: SyncState[] = [];
  const notices: string[] = [];
  const localCopy = vi.fn();
  const sync = startCollabSync({
    onLocalCopy: localCopy,
    itemId: 'item-1',
    doc,
    fragmentName: 'default',
    cacheScope: SCOPE,
    bodyCache: cache,
    getAccessToken: () => Promise.resolve('token'),
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
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
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
    for (let index = 0; index < 5; index += 1) {
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
