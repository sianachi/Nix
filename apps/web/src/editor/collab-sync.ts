import { SCHEMA_VERSION } from '@nix/editor-schema';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import type * as Y from 'yjs';

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
export const FRAGMENT_NAME = 'default';

/** Protocol frame types, mirrored from the collaboration service. */
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_NOTICE = 2;

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
  readonly itemId: string;
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

  /** Closes the socket and stops reconnecting. The document itself keeps every edit. */
  destroy: () => void;
}

const DEFAULT_BASE_URL = '/collab';

export function startCollabSync(options: CollabSyncOptions): CollabSync {
  const {
    itemId,
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

  function onDocUpdate(update: Uint8Array, origin: unknown): void {
    if (origin === REMOTE_ORIGIN) {
      return;
    }
    if (socket === null || !ready || socket.readyState !== 1 || mode === 'read') {
      unsynced = true;
      report();
      return;
    }
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    socket.send(encoding.toUint8Array(encoder));
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
    if (destroyed) {
      return;
    }

    const token = await getAccessToken();
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

    const next = createSocket(`${baseUrl}/documents/${itemId}/ws`);
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
        retryMs = minRetryMs;
        mode = frame.mode === 'read' ? 'read' : 'write';

        // Both sides open with sync step 1: the server's pulls this document's offline
        // edits, and this one pulls everything the server holds.
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.writeSyncStep1(encoder, doc);
        from.send(encoding.toUint8Array(encoder));

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
        if (notice.code === 'read_only') {
          // The server stopped accepting this session's writes - a revoked grant, told
          // honestly instead of silently dropping edits.
          mode = 'read';
          report();
        }
        if (typeof notice.code === 'string') {
          onNotice?.({ code: notice.code, detail: notice.detail ?? '' });
        }
        return;
      }
      default:
        return;
    }
  }

  onState('connecting');
  void connect();

  return {
    awareness,
    destroy(): void {
      destroyed = true;
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
