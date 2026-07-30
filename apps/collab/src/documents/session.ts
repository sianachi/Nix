import { randomUUID } from 'node:crypto';

import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import type { Pool } from 'pg';
import * as Y from 'yjs';

import { appendUpdates, type ContentDocRow } from '../db/documents.ts';
import { withTenantScope } from '../db/tenant-scope.ts';
import type { CollabMetrics } from '../metrics.ts';
import { MESSAGE_AWARENESS, MESSAGE_SYNC, encodeNotice, readBinaryFrame } from '../ws/protocol.ts';
import type { SocketSession } from '../ws/server.ts';
import { loadDocument, writeSnapshotNow } from './service.ts';

/** The thresholds a resident document lives by. All of them configuration, none of them lore. */
export interface SessionConfig {
  /** How long pending updates may wait before a flush. The crash-loss window. */
  readonly flushMs: number;

  /** How many pending bytes force a flush before the timer does. */
  readonly flushBytes: number;

  /** Updates between snapshots. */
  readonly snapshotEvery: number;

  /** How long an active document may go without a snapshot, whatever the update count. */
  readonly snapshotIntervalMs: number;
}

export interface SessionContext {
  readonly pool: Pool;
  readonly config: SessionConfig;
  readonly metrics?: CollabMetrics | undefined;

  /**
   * Fired once per flush, so Core can bump the item's modification stamp. Best-effort by
   * contract: the log append already succeeded, and a stale envelope stamp is a smaller
   * wrong than a failed flush.
   */
  readonly onFlushed?: ((session: DocumentSession) => void) | undefined;

  readonly now?: (() => number) | undefined;
}

type LifecycleState = 'active' | 'draining' | 'unloaded';

interface PendingUpdate {
  readonly bytes: Uint8Array;
  readonly principalId: string;
  readonly clientId: string;
}

/**
 * One document, resident: the loaded `Y.Doc`, the sockets editing it, the awareness they
 * share, and the queue of updates not yet flushed to the log.
 *
 * This is the object MVP-1 deliberately did not build. The HTTP path replays snapshot plus
 * tail on every append, which is correct and unaffordable past a handful of editors; here
 * the replay happens once at load, updates apply to live state, and the log sees one
 * batched transaction per flush window instead of one row lock per keystroke burst.
 *
 * **What is in memory ahead of the last flush is the crash-loss window** - bounded by
 * `flushMs` and `flushBytes`, documented, and recovered by clients re-sending on reconnect
 * via sync step 1. Awareness is never persisted at all: presence is a fact about now.
 */
export class DocumentSession {
  readonly itemId: string;
  readonly docRow: ContentDocRow;
  readonly tenantId: string;

  #state: LifecycleState = 'active';
  readonly #doc: Y.Doc;
  readonly #awareness: awarenessProtocol.Awareness;
  readonly #context: SessionContext;

  readonly #sockets = new Set<SocketSession>();
  readonly #clientIdsBySocket = new Map<SocketSession, Set<number>>();
  readonly #writerIdBySocket = new Map<SocketSession, string>();

  #pending: PendingUpdate[] = [];
  #pendingBytes = 0;
  #flushTimer: NodeJS.Timeout | null = null;
  #flushing: Promise<void> = Promise.resolve();

  #headSeq: bigint;
  #lastSnapshotSeq: bigint;
  #lastSnapshotAt: number;
  #lastWriter: { principalId: string; token: string } | null = null;

  #idleSince: number | null = null;

  /** Awareness changes are coalesced onto a short tick rather than fanned out per message. */
  readonly #awarenessDirty = new Set<number>();
  #awarenessTimer: NodeJS.Timeout | null = null;

  #encodedBase: number;
  #bytesSinceEncode = 0;

  private constructor(
    itemId: string,
    docRow: ContentDocRow,
    tenantId: string,
    doc: Y.Doc,
    context: SessionContext,
  ) {
    this.itemId = itemId;
    this.docRow = docRow;
    this.tenantId = tenantId;
    this.#doc = doc;
    this.#context = context;
    this.#headSeq = BigInt(docRow.head_seq);
    this.#lastSnapshotSeq = this.#headSeq;
    this.#lastSnapshotAt = this.now();
    this.#encodedBase = Y.encodeStateAsUpdate(doc).byteLength;
    this.#awareness = new awarenessProtocol.Awareness(doc);
    // The server itself has no cursor; holding a local state would advertise a phantom
    // participant to every client.
    this.#awareness.setLocalState(null);

    this.#doc.on('update', (update: Uint8Array, origin: unknown) => {
      this.#onDocUpdate(update, origin);
    });

    this.#awareness.on(
      'update',
      (change: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        this.#onAwarenessUpdate(change, origin);
      },
    );
  }

  /** Loads the document once - snapshot plus tail - and holds it. */
  static async load(
    itemId: string,
    docRow: ContentDocRow,
    scope: { tenantId: string; principalId: string },
    context: SessionContext,
  ): Promise<DocumentSession> {
    const doc = await withTenantScope(context.pool, scope, (sql) =>
      loadDocument(sql, scope.tenantId, docRow),
    );

    return new DocumentSession(itemId, docRow, scope.tenantId, doc, context);
  }

  get state(): LifecycleState {
    return this.#state;
  }

  get socketCount(): number {
    return this.#sockets.size;
  }

  /** When the last socket left, or null while any is attached. The eviction clock. */
  get idleSince(): number | null {
    return this.#idleSince;
  }

  /**
   * Roughly how many bytes this document holds resident: the encoded state at the last
   * snapshot plus every update applied since. An estimate on purpose - counting real heap
   * would cost more than the number is worth - and always an overestimate, which is the
   * safe direction for a capacity decision.
   */
  get estimatedBytes(): number {
    return this.#encodedBase + this.#bytesSinceEncode + this.#pendingBytes;
  }

  /**
   * Who last wrote, and with which credential - what the touched notification acts as.
   * Null until somebody writes; a flush with no writer notifies nobody.
   */
  get lastWriter(): { principalId: string; token: string } | null {
    return this.#lastWriter;
  }

  /** Attaches a socket. Arriving during a drain cancels it - reconnect wins. */
  attach(socket: SocketSession): void {
    this.#state = 'active';
    this.#idleSince = null;
    this.#sockets.add(socket);
    this.#clientIdsBySocket.set(socket, new Set());
    this.#writerIdBySocket.set(socket, `ws:${randomUUID()}`);
  }

  /**
   * Starts sync with a socket that has been told it is ready: sends sync step 1, and the
   * current awareness roster so a joiner sees who is present before anyone next moves.
   */
  beginSync(socket: SocketSession): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, this.#doc);
    socket.socket.send(encoding.toUint8Array(encoder));

    const states = this.#awareness.getStates();
    if (states.size > 0) {
      const awarenessEncoder = encoding.createEncoder();
      encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        awarenessEncoder,
        awarenessProtocol.encodeAwarenessUpdate(this.#awareness, [...states.keys()]),
      );
      socket.socket.send(encoding.toUint8Array(awarenessEncoder));
    }
  }

  /** Routes one binary frame from an attached socket. */
  handleMessage(socket: SocketSession, data: Uint8Array): void {
    const frame = readBinaryFrame(data);
    if (frame === null) {
      return;
    }

    switch (frame.messageType) {
      case MESSAGE_SYNC:
        this.#handleSync(socket, frame.decoder);
        return;
      case MESSAGE_AWARENESS:
        try {
          awarenessProtocol.applyAwarenessUpdate(
            this.#awareness,
            decoding.readVarUint8Array(frame.decoder),
            socket,
          );
        } catch {
          // A malformed awareness payload costs its sender their cursor, nothing more.
        }
        return;
      default:
        return;
    }
  }

  #handleSync(socket: SocketSession, decoder: decoding.Decoder): void {
    const messageType = decoding.peekVarUint(decoder);
    const carriesWrites = messageType !== syncProtocol.messageYjsSyncStep1;

    if (carriesWrites && socket.mode !== 'write') {
      // §17's contract, live: a reader's edits are refused, told so, and never applied -
      // and the socket survives, because losing presence over a refused edit helps nobody.
      socket.socket.send(
        encodeNotice({ code: 'read_only', detail: 'You may read this document but not change it.' }),
      );
      return;
    }

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    try {
      syncProtocol.readSyncMessage(decoder, encoder, this.#doc, socket);
    } catch {
      socket.socket.send(
        encodeNotice({ code: 'update_unreadable', detail: 'The payload is not a Yjs update.' }),
      );
      return;
    }

    if (encoding.length(encoder) > 1) {
      socket.socket.send(encoding.toUint8Array(encoder));
    }
  }

  #onDocUpdate(update: Uint8Array, origin: unknown): void {
    this.#bytesSinceEncode += update.byteLength;

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    const message = encoding.toUint8Array(encoder);

    for (const socket of this.#sockets) {
      if (socket !== origin) {
        socket.socket.send(message);
      }
    }

    if (!this.#isAttachedSocket(origin)) {
      return;
    }

    this.#pending.push({
      bytes: update,
      principalId: origin.authorization.principalId,
      clientId: this.#writerIdBySocket.get(origin) ?? 'ws:unknown',
    });
    this.#pendingBytes += update.byteLength;
    this.#lastWriter = { principalId: origin.authorization.principalId, token: origin.token };

    if (this.#pendingBytes >= this.#context.config.flushBytes) {
      this.scheduleFlush(0);
    } else {
      this.scheduleFlush(this.#context.config.flushMs);
    }
  }

  #isAttachedSocket(origin: unknown): origin is SocketSession {
    return this.#sockets.has(origin as SocketSession);
  }

  #onAwarenessUpdate(
    change: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void {
    const changed = [...change.added, ...change.updated, ...change.removed];

    if (this.#isAttachedSocket(origin)) {
      const owned = this.#clientIdsBySocket.get(origin);
      if (owned !== undefined) {
        for (const id of change.added) {
          owned.add(id);
        }
        for (const id of change.removed) {
          owned.delete(id);
        }
      }
    }

    for (const id of changed) {
      this.#awarenessDirty.add(id);
    }

    // Coalesced: with a hundred editors, per-message fan-out is editors-squared traffic,
    // and a cursor that moves fifty times in fifty milliseconds is one move to a reader.
    this.#awarenessTimer ??= setTimeout(() => {
      this.#awarenessTimer = null;
      this.#broadcastAwareness();
    }, 50);
  }

  #broadcastAwareness(): void {
    if (this.#awarenessDirty.size === 0 || this.#sockets.size === 0) {
      this.#awarenessDirty.clear();
      return;
    }

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.#awareness, [...this.#awarenessDirty]),
    );
    const message = encoding.toUint8Array(encoder);
    this.#awarenessDirty.clear();

    for (const socket of this.#sockets) {
      socket.socket.send(message);
    }
  }

  /** Schedules a flush no later than `inMs` from now, keeping any earlier deadline. */
  scheduleFlush(inMs: number): void {
    if (this.#pending.length === 0) {
      return;
    }
    if (inMs <= 0) {
      if (this.#flushTimer !== null) {
        clearTimeout(this.#flushTimer);
        this.#flushTimer = null;
      }
      void this.flush();
      return;
    }
    this.#flushTimer ??= setTimeout(() => {
      this.#flushTimer = null;
      void this.flush();
    }, inMs);
  }

  /**
   * Flushes the pending queue to the log, one transaction per same-principal run.
   *
   * The queue is split into maximal runs of one principal because `actor_id` is a per-row
   * fact and the tenant scope names one principal per transaction - and order must hold,
   * so runs flush sequentially, never in parallel. At a 500 ms window a queue is almost
   * always a single run, so the batching survives the honesty.
   */
  async flush(): Promise<void> {
    const previous = this.#flushing;
    let release: () => void = () => undefined;
    this.#flushing = new Promise((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      const queue = this.#pending;
      if (queue.length === 0) {
        return;
      }
      this.#pending = [];
      this.#pendingBytes = 0;
      if (this.#flushTimer !== null) {
        clearTimeout(this.#flushTimer);
        this.#flushTimer = null;
      }

      const started = this.now();

      for (const run of principalRuns(queue)) {
        const { lastSeq } = await withTenantScope(
          this.#context.pool,
          { tenantId: this.tenantId, principalId: run.principalId },
          (sql) =>
            appendUpdates(sql, {
              tenantId: this.tenantId,
              docId: this.docRow.doc_id,
              updates: run.updates,
              actorId: run.principalId,
            }),
        );
        this.#headSeq = lastSeq;
        this.#context.metrics?.updatesAppendedTotal.inc(run.updates.length);
      }

      await this.#maybeSnapshot();

      this.#context.metrics?.flushSeconds.observe((this.now() - started) / 1000);
      this.#context.onFlushed?.(this);
    } finally {
      release();
    }
  }

  async #maybeSnapshot(): Promise<void> {
    const due =
      this.#headSeq - this.#lastSnapshotSeq >= BigInt(this.#context.config.snapshotEvery) ||
      (this.#headSeq > this.#lastSnapshotSeq &&
        this.now() - this.#lastSnapshotAt >= this.#context.config.snapshotIntervalMs);

    if (!due) {
      return;
    }

    await this.#snapshotNow();
  }

  async #snapshotNow(): Promise<void> {
    const principal = this.#lastWriter?.principalId ?? null;
    if (principal === null || this.#headSeq <= this.#lastSnapshotSeq) {
      return;
    }

    const seq = this.#headSeq;
    const written = await withTenantScope(
      this.#context.pool,
      { tenantId: this.tenantId, principalId: principal },
      (sql) =>
        writeSnapshotNow(sql, {
          tenantId: this.tenantId,
          docId: this.docRow.doc_id,
          seq,
          state: this.#doc,
        }),
    );

    if (written) {
      this.#lastSnapshotSeq = seq;
      this.#lastSnapshotAt = this.now();
      this.#encodedBase = Y.encodeStateAsUpdate(this.#doc).byteLength;
      this.#bytesSinceEncode = 0;
    }
  }

  /** Detaches a socket; the last one out flushes immediately and starts the idle clock. */
  detach(socket: SocketSession): void {
    if (!this.#sockets.delete(socket)) {
      return;
    }

    const owned = this.#clientIdsBySocket.get(socket);
    this.#clientIdsBySocket.delete(socket);
    this.#writerIdBySocket.delete(socket);
    if (owned !== undefined && owned.size > 0) {
      awarenessProtocol.removeAwarenessStates(this.#awareness, [...owned], null);
    }

    if (this.#sockets.size === 0) {
      this.#idleSince = this.now();
      // Flush on disconnect is one of the three §17 triggers, and it is what bounds the
      // crash-loss window to "sub-second" rather than "whatever was pending when the last
      // person left".
      this.scheduleFlush(0);
    }
  }

  /**
   * Drains: final flush, snapshot, and - if nobody reconnected while that ran - unload.
   *
   * Returns true when the session reached `unloaded` and may be discarded. False means a
   * reconnect cancelled the drain and the session is active again, which is the state
   * diagram's `draining --> active` edge.
   */
  async drain(): Promise<boolean> {
    this.#state = 'draining';

    await this.flush();
    await this.#snapshotNow();

    if (this.#sockets.size > 0) {
      this.#state = 'active';
      return false;
    }

    this.#state = 'unloaded';
    if (this.#awarenessTimer !== null) {
      clearTimeout(this.#awarenessTimer);
      this.#awarenessTimer = null;
    }
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    this.#awareness.destroy();
    this.#doc.destroy();
    return true;
  }

  /** Closes every attached socket with a code, for shutdown and lost ownership. */
  closeSockets(code: number, reason: string): void {
    for (const socket of [...this.#sockets]) {
      socket.socket.close(code, reason);
    }
  }

  private now(): number {
    return this.#context.now?.() ?? Date.now();
  }
}

interface PrincipalRun {
  readonly principalId: string;
  readonly updates: { bytes: Uint8Array; clientId: string }[];
}

/** Splits a queue into maximal contiguous runs of one principal, order preserved. */
function principalRuns(queue: readonly PendingUpdate[]): PrincipalRun[] {
  const runs: PrincipalRun[] = [];
  for (const update of queue) {
    const entry = { bytes: update.bytes, clientId: update.clientId };
    const current = runs[runs.length - 1];
    if (current !== undefined) {
      if (current.principalId === update.principalId) {
        current.updates.push(entry);
        continue;
      }
    }
    runs.push({ principalId: update.principalId, updates: [entry] });
  }
  return runs;
}
