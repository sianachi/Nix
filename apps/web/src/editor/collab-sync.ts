import { registerPendingWork } from '../lib/pending-work';
import { createDraftJournal, type DraftState, type DraftRecord } from './draft-journal';
import { SCHEMA_VERSION } from '@nix/editor-schema';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

/**
 * The document body's transport: a WebSocket speaking the Yjs sync and awareness
 * protocols to the collaboration service.
 *
 * **Local edits apply to the document immediately.** The network is propagation, never the
 * thing between a keystroke and the screen - and the document itself is the offline queue:
 * a CRDT needs no buffer of unsent updates, because reconnecting replays the difference
 * through sync step 1 exactly as if nothing had been missed.
 *
 * **The handshake carries the token in the first frame**, not in the URL: browsers cannot
 * set headers on a WebSocket, and a token in a query string would land in every proxy log
 * between here and the server. Until the server answers `ready`, nothing else is sent.
 *
 * The connection state is reported in terms a writer can act on, and honestly: `live`
 * means edits are streaming, `pending` means edits exist that the server does not have
 * yet, `readonly` means the server said so, and `degraded` means the server is up but
 * cannot take this document right now.
 */

export type SyncState = 'connecting' | 'live' | 'pending' | 'readonly' | 'degraded' | 'offline';

/**
 * The Yjs root the prose editor binds to. One name, agreed with the collaboration
 * service; a mismatch would produce two documents that merge cleanly and share no text.
 */
/**
 * How long local updates are held before they are merged and sent.
 *
 * Short enough that a colleague sees typing as typing rather than in bursts - well inside the
 * ~100ms at which a delay stops feeling instant - and long enough that a pointer drag emitting
 * sixty updates a second leaves as roughly twelve frames rather than sixty. The server's ceiling
 * is ten a second per document, so this keeps a legitimate client an order of magnitude clear of
 * a limit that exists to catch a broken one.
 */
const FLUSH_MS = 80;

export const FRAGMENT_NAME = 'default';

/** Protocol frame types, mirrored from the collaboration service. */
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_NOTICE = 2;
const MESSAGE_PERSISTENCE_BARRIER = 3;
const BARRIER_TIMEOUT_MS = 15_000;

/** Close codes the provider reacts to by name. Everything else is a plain drop. */
const CLOSE_UNAUTHENTICATED = 4401;
const CLOSE_REVOKED = 4403;
const CLOSE_SCHEMA_MISMATCH = 4409;
const CLOSE_AT_CAPACITY = 4413;
const CLOSE_OWNED_ELSEWHERE = 4423;
const CLOSE_DRAINING = 1012;

/**
 * The socket surface this module needs - the browser's WebSocket satisfies it, and a test
 * can supply a fake without reaching for a network.
 */
export interface ProviderSocket {
  binaryType: string;
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: (() => void) | null;
}

export interface CollabSyncOptions {
  readonly draftScope?: string;
  readonly onDraftState?: (state: DraftState) => void;
  readonly itemId: string;
  /** Overrides the ordinary item WebSocket route for staged or library-only document aliases. */
  readonly documentPath?: string | undefined;
  readonly doc: Y.Doc;
  readonly fragmentName: string;
  readonly getAccessToken: () => Promise<string | null>;
  readonly onState: (state: SyncState) => void;
  readonly baseUrl?: string;

  /**
   * An awareness instance to carry, when the caller's editor plugins need it before the
   * provider exists. Owned by the caller, so destroying the provider leaves it alive.
   */
  readonly awareness?: awarenessProtocol.Awareness;

  /** Builds the socket. Defaults to the browser's WebSocket against the same origin. */
  readonly createSocket?: (url: string) => ProviderSocket;

  /** Reconnect backoff bounds, exposed for tests that should not wait real seconds. */
  readonly minRetryMs?: number;
  readonly maxRetryMs?: number;

  /**
   * Every notice the server sends, not only the `read_only` one this module already acts
   * on. A refused update carries a code (`document_too_many_nodes`, `document_too_large`,
   * `document_does_not_parse`, `rate_limited`) that `SyncState`'s six values have no room
   * for - they describe the connection, not one refused edit - so a caller that needs to
   * say something more specific than "saving locally" reads it here instead. Optional
   * because most editors have nothing more specific to say.
   */
  readonly onNotice?: (notice: { code: string; detail: string }) => void;
}

export interface CollabSync {
  /**
   * Presence: this client's cursor and everyone else's. Never persisted anywhere - the
   * server broadcasts it and forgets it.
   */
  readonly awareness: awarenessProtocol.Awareness;

  /** Flushes local frames and resolves only after the server has persisted every prior update. */
  readonly flushAndWait: () => Promise<void>;

  /** Closes the socket and stops reconnecting. The document itself keeps every edit. */
  destroy: () => void;
}

const DEFAULT_BASE_URL = '/collab';

export function startCollabSync(options: CollabSyncOptions): CollabSync {
  const {
    itemId,
    documentPath,
    doc,
    getAccessToken,
    onState,
    onNotice,
    baseUrl = DEFAULT_BASE_URL,
    minRetryMs = 1_000,
    maxRetryMs = 30_000,
  } = options;

  const createSocket =
    options.createSocket ??
    ((url: string): ProviderSocket => new WebSocket(resolveUrl(url)) as unknown as ProviderSocket);

  const draft =
    options.draftScope && typeof indexedDB !== 'undefined'
      ? createDraftJournal(options.draftScope, (state) => options.onDraftState?.(state))
      : null;
  let restoredDrafts: DraftRecord[] = [];
  const draftsReady = draft
    ?.read()
    .then((records) => {
      restoredDrafts = records;
    })
    .catch(() => {
      options.onDraftState?.('error');
    });
  let localRevision = 0;
  let confirmedRevision = 0;
  let confirming = false;
  let writeRefused = false;
  const hasWriteRefusal = (): boolean => writeRefused;
  const browserWindow = typeof window === 'undefined' ? undefined : window;
  const browserDocument = typeof document === 'undefined' ? undefined : document;
  let connecting = false;
  const restoreOrigin = Symbol('restored-draft');

  const ownsAwareness = options.awareness === undefined;
  const awareness = options.awareness ?? new awarenessProtocol.Awareness(doc);

  let socket: ProviderSocket | null = null;
  let destroyed = false;
  let mode: 'write' | 'read' = 'write';
  let ready = false;
  let retryMs = minRetryMs;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  /** Whether local edits exist the server has not seen - the honest half of "saved". */
  let unsynced = false;

  function isDestroyed(): boolean {
    return destroyed;
  }

  function report(): void {
    if (destroyed) {
      return;
    }
    if (ready) {
      onState(mode === 'read' ? 'readonly' : 'live');
    } else if (unsynced) {
      onState('pending');
    }
  }

  function sendFrame(bytes: Uint8Array): void {
    if (socket !== null && ready && socket.readyState === 1) {
      socket.send(bytes);
    }
  }

  /**
   * Local updates waiting to go out, and the timer that will send them.
   *
   * **Why they wait at all.** Yjs emits one update per transaction, and this used to put one
   * WebSocket frame on the wire for each. For prose that is roughly a frame per keystroke, which
   * is fine. For a canvas it is not: pointer movement reports a scene change on every frame, so
   * dragging one shape produces about sixty updates a second - and the server's per-principal
   * ceiling is six hundred a minute. Ten seconds of dragging spent a whole minute's budget, and
   * one person on their own was refused as if they were a runaway client.
   *
   * Merging first is free, because that is what Yjs updates are: `mergeUpdates` produces one
   * update with the same effect as applying them in order, so a coalesced flush is not an
   * approximation of the sixty frames it replaces - it is the same edit, sent once.
   */
  let pending: Uint8Array[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let barrierSequence = 0;
  const barriers = new Map<
    string,
    {
      readonly resolve: () => void;
      readonly reject: (reason: Error) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();

  function rejectBarriers(detail: string): void {
    for (const barrier of barriers.values()) {
      clearTimeout(barrier.timer);
      barrier.reject(new Error(detail));
    }
    barriers.clear();
  }

  function flushPending(): void {
    flushTimer = null;

    if (pending.length === 0) {
      return;
    }

    if (socket === null || !ready || socket.readyState !== 1 || mode === 'read') {
      // Kept, not dropped. They go out on the next flush after the socket comes back, and until
      // then `unsynced` is what makes the footer say so rather than claiming everything is saved.
      unsynced = true;
      report();
      return;
    }

    const merged = pending.length === 1 ? pending[0] : Y.mergeUpdates(pending);
    pending = [];

    if (merged === undefined) {
      return;
    }

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, merged);
    socket.send(encoding.toUint8Array(encoder));
  }

  function onDocUpdate(update: Uint8Array, origin: unknown): void {
    if (origin === REMOTE_ORIGIN) {
      return;
    }

    localRevision += 1;
    if (origin !== restoreOrigin) draft?.append(update);
    pending.push(update);

    if (socket === null || !ready || socket.readyState !== 1 || mode === 'read') {
      unsynced = true;
      report();
      return;
    }

    flushTimer ??= setTimeout(flushPending, FLUSH_MS);
  }

  function onAwarenessUpdate(
    change: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void {
    if (origin === REMOTE_ORIGIN) {
      return;
    }
    const changed = [...change.added, ...change.updated, ...change.removed];
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(awareness, changed),
    );
    sendFrame(encoding.toUint8Array(encoder));
  }

  doc.on('update', onDocUpdate);
  awareness.on('update', onAwarenessUpdate);

  function scheduleReconnect(delayMs: number): void {
    if (destroyed || retryTimer !== null) {
      return;
    }
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, jittered(delayMs));
  }

  async function connect(): Promise<void> {
    if (destroyed || connecting) {
      return;
    }

    connecting = true;
    await draftsReady;
    const token = await getAccessToken().catch(() => null);
    connecting = false;
    if (isDestroyed()) {
      // destroy() may have run while the token was being fetched; the narrowing above
      // cannot see that, so the check goes through a call the compiler treats as opaque.
      return;
    }
    if (token === null) {
      onState('offline');
      scheduleReconnect(retryMs);
      retryMs = Math.min(retryMs * 2, maxRetryMs);
      return;
    }

    const next = createSocket(documentPath ?? `${baseUrl}/documents/${itemId}/ws`);
    next.binaryType = 'arraybuffer';
    socket = next;
    ready = false;

    next.onopen = () => {
      next.send(JSON.stringify({ type: 'auth', token, schemaVersion: SCHEMA_VERSION }));
    };

    next.onmessage = (event) => {
      handleMessage(next, event.data);
    };

    next.onerror = () => {
      // onclose follows; reacting twice would double the backoff bookkeeping.
    };

    next.onclose = (event) => {
      if (socket !== next) {
        return;
      }
      socket = null;
      ready = false;
      rejectBarriers('The document disconnected before its changes were confirmed.');

      if (destroyed) {
        return;
      }

      // Everyone else's presence is stale the moment the wire is gone; keeping their
      // cursors on screen would be showing people who may have left.
      awarenessProtocol.removeAwarenessStates(
        awareness,
        [...awareness.getStates().keys()].filter((id) => id !== doc.clientID),
        REMOTE_ORIGIN,
      );

      const verdict = classifyClose(event.code);
      onState(verdict.state);
      if (event.code === CLOSE_REVOKED) {
        restoredDrafts = [];
        void draft?.discard().catch(() => {
          options.onDraftState?.('error');
        });
        onNotice?.({ code: 'access_revoked', detail: 'Access to this document was revoked.' });
      }
      scheduleReconnect(verdict.delayMs ?? retryMs);
      if (verdict.delayMs === undefined) {
        retryMs = Math.min(retryMs * 2, maxRetryMs);
      }
    };
  }

  function handleMessage(from: ProviderSocket, data: unknown): void {
    if (typeof data === 'string') {
      const frame = JSON.parse(data) as { type?: string; mode?: string };
      if (frame.type === 'ready') {
        ready = true;
        writeRefused = false;
        retryMs = minRetryMs;
        mode = frame.mode === 'read' ? 'read' : 'write';
        if (mode === 'write' && restoredDrafts.length > 0) {
          for (const record of restoredDrafts) {
            try {
              Y.applyUpdate(doc, record.update, restoreOrigin);
              pending.push(record.update);
            } catch {
              writeRefused = true;
              options.onDraftState?.('error');
              onNotice?.({
                code: 'local_draft_unreadable',
                detail:
                  'A saved draft could not be recovered. Keep this device’s data until the draft is recovered.',
              });
            }
          }
          localRevision += 1;
          restoredDrafts = [];
        } else if (mode === 'read') {
          restoredDrafts = [];
          void draft?.discard().catch(() => {
            options.onDraftState?.('error');
          });
        }

        // Both sides open with sync step 1: the server's pulls this document's offline
        // edits, and this one pulls everything the server holds.
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.writeSyncStep1(encoder, doc);
        from.send(encoding.toUint8Array(encoder));

        // Anything that accumulated while the socket was away goes out now. Sync step 1 above
        // would eventually reconcile it anyway, but not until the server answers - and until then
        // the footer would be claiming a connection while the edits sat here.
        if (pending.length > 0) {
          flushTimer ??= setTimeout(flushPending, FLUSH_MS);
        }

        // Presence resumes with the connection.
        const state = awareness.getLocalState();
        if (state !== null) {
          const awarenessEncoder = encoding.createEncoder();
          encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
          encoding.writeVarUint8Array(
            awarenessEncoder,
            awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID]),
          );
          from.send(encoding.toUint8Array(awarenessEncoder));
        }

        unsynced = false;
        report();
      }
      return;
    }

    const bytes = toBytes(data);
    if (bytes === null) {
      return;
    }

    const decoder = decoding.createDecoder(bytes);
    const messageType = decoding.readVarUint(decoder);

    switch (messageType) {
      case MESSAGE_SYNC: {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(decoder, encoder, doc, REMOTE_ORIGIN);
        if (encoding.length(encoder) > 1) {
          from.send(encoding.toUint8Array(encoder));
        }
        return;
      }
      case MESSAGE_AWARENESS: {
        awarenessProtocol.applyAwarenessUpdate(
          awareness,
          decoding.readVarUint8Array(decoder),
          REMOTE_ORIGIN,
        );
        return;
      }
      case MESSAGE_NOTICE: {
        const notice = JSON.parse(decoding.readVarString(decoder)) as {
          code?: string;
          detail?: string;
        };
        writeRefused = true;
        if (notice.code === 'read_only') {
          // The server stopped accepting this session's writes - a revoked grant, told
          // honestly instead of silently dropping edits.
          mode = 'read';
          void draft?.discard().catch(() => {
            options.onDraftState?.('error');
          });
          report();
        }
        if (typeof notice.code === 'string') {
          onNotice?.({ code: notice.code, detail: notice.detail ?? '' });
        }
        return;
      }
      case MESSAGE_PERSISTENCE_BARRIER: {
        const barrierId = decoding.readVarString(decoder);
        const barrier = barriers.get(barrierId);
        if (barrier === undefined) return;
        clearTimeout(barrier.timer);
        barriers.delete(barrierId);
        barrier.resolve();
        return;
      }
      default:
        return;
    }
  }

  onState('connecting');
  void connect();

  const sync: CollabSync = {
    awareness,
    flushAndWait(): Promise<void> {
      const current = socket;
      if (current === null || !ready || current.readyState !== 1 || mode === 'read') {
        return Promise.reject(
          new Error('The document must be connected and editable before its changes can be saved.'),
        );
      }
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flushPending();

      barrierSequence += 1;
      const barrierId = `${String(doc.clientID)}-${String(barrierSequence)}`;
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          barriers.delete(barrierId);
          reject(new Error('The document changes were not confirmed in time.'));
        }, BARRIER_TIMEOUT_MS);
        barriers.set(barrierId, { resolve, reject, timer });
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_PERSISTENCE_BARRIER);
        encoding.writeVarString(encoder, barrierId);
        try {
          current.send(encoding.toUint8Array(encoder));
        } catch (reason) {
          clearTimeout(timer);
          barriers.delete(barrierId);
          reject(reason instanceof Error ? reason : new Error('The document could not be saved.'));
        }
      });
    },
    destroy(): void {
      // Last chance for anything still waiting on the flush timer. Closing the editor is exactly
      // when a person expects their last keystroke to have counted, and up to `FLUSH_MS` of it is
      // held here by design.
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flushPending();

      destroyed = true;
      unregisterPending();
      clearInterval(confirmationTimer);
      browserWindow?.removeEventListener('online', resume);
      browserDocument?.removeEventListener('visibilitychange', visible);
      rejectBarriers('The editor closed before its changes were confirmed.');
      doc.off('update', onDocUpdate);
      awareness.off('update', onAwarenessUpdate);
      if (ownsAwareness) {
        awareness.destroy();
      }
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
      }
      socket?.close(1000, 'The editor closed.');
      socket = null;
    },
  };
  async function confirm(): Promise<void> {
    if (localRevision === confirmedRevision || confirming || destroyed) return;
    confirming = true;
    const revision = localRevision;
    try {
      const records = (await draft?.snapshot()) ?? [];
      if (hasWriteRefusal()) throw new Error('The server refused an edit.');
      await sync.flushAndWait();
      if (hasWriteRefusal()) throw new Error('The server refused an edit.');
      await draft?.acknowledge(records);
      confirmedRevision = revision;
    } finally {
      confirming = false;
    }
  }
  const unregisterPending = registerPendingWork(async () => {
    if (hasWriteRefusal()) throw new Error('Resolve the refused edit before updating.');
    if (localRevision !== confirmedRevision) {
      await sync.flushAndWait();
      if (hasWriteRefusal()) throw new Error('Resolve the refused edit before updating.');
    }
  });
  const confirmationTimer = setInterval(() => {
    void confirm().catch(() => undefined);
  }, 2_000);
  const resume = (): void => {
    if (destroyed || connecting) return;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    const previous = socket;
    socket = null;
    ready = false;
    rejectBarriers('Reconnecting to confirm pending edits.');
    previous?.close(1000, 'Resuming the editor.');
    onState('connecting');
    void connect();
  };
  const visible = (): void => {
    if (browserDocument?.visibilityState === 'visible') resume();
  };
  browserWindow?.addEventListener('online', resume);
  browserDocument?.addEventListener('visibilitychange', visible);
  return sync;
}

/** How a close code translates into a state and a retry cadence. */
function classifyClose(code: number): { state: SyncState; delayMs?: number } {
  switch (code) {
    case CLOSE_UNAUTHENTICATED:
    case CLOSE_REVOKED:
      // The fix is a fresh token, which the next connect fetches anyway.
      return { state: 'offline' };
    case CLOSE_SCHEMA_MISMATCH:
      // This build is older than the document. Retrying will not change that; reloading
      // the app will, and the footer copy says so.
      return { state: 'degraded', delayMs: 60_000 };
    case CLOSE_AT_CAPACITY:
    case CLOSE_OWNED_ELSEWHERE:
      // The server is up and said "not this document, not right now" - back off harder
      // than for a network blip, and keep the edits local meanwhile.
      return { state: 'degraded', delayMs: 5_000 };
    case CLOSE_DRAINING:
      // A rollout. The replacement is seconds away.
      return { state: 'offline', delayMs: 1_000 };
    default:
      return { state: 'offline' };
  }
}

function jittered(delayMs: number): number {
  return delayMs / 2 + Math.random() * (delayMs / 2);
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  return null;
}

function resolveUrl(path: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${path}`;
}

/**
 * Marks updates that came from the server, so the local handler does not send them
 * straight back.
 *
 * A symbol rather than a string: origins are compared by identity, and a string could
 * collide with one some other plugin chose.
 */
const REMOTE_ORIGIN = Symbol('nix.collab.remote');
