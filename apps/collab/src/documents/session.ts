import { randomUUID } from 'node:crypto';

import { SCHEMA_VERSION } from '@nix/editor-schema';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import type { Pool } from 'pg';
import * as Y from 'yjs';

import { appendUpdates, type ContentDocRow } from '../db/documents.ts';
import { withTenantScope } from '../db/tenant-scope.ts';
import type { CollabMetrics } from '../metrics.ts';
import {
  MESSAGE_AWARENESS,
  MESSAGE_PERSISTED,
  MESSAGE_SYNC,
  CLOSE_CODES,
  encodeNotice,
  encodePersisted,
  readBinaryFrame,
} from '../ws/protocol.ts';
import type { SocketSession } from '../ws/server.ts';
import { noteStrategy, type BodyKindStrategy } from './body-kinds.ts';
import { LIMITS, rejection, type RateWindow, type Rejection } from './limits.ts';
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
   * Per-principal, per-document backpressure - the same window the HTTP path enforces,
   * ideally the same instance, so moving transports does not double anyone's budget.
   */
  readonly rateWindow?: RateWindow | undefined;

  /** Where refusals worth an operator's attention go. Defaults to silence, not stdout. */
  readonly log?: ((message: string) => void) | undefined;

  /**
   * Fired once per flush, so Core can bump the item's modification stamp. Best-effort by
   * contract: the log append already succeeded, and a stale envelope stamp is a smaller
   * wrong than a failed flush.
   */
  readonly onFlushed?: ((session: DocumentSession) => void) | undefined;

  /**
   * Atomically moves this session's contribution to the process-wide resident-byte account.
   * Growth may be refused before the Yjs document is mutated; shrinkage is always accepted.
   */
  readonly resizeResident?:
    ((session: DocumentSession, nextEstimatedBytes: number) => boolean) | undefined;

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

  /** How this body is validated and materialised - the item's `type`, resolved once at load. */
  readonly strategy: BodyKindStrategy;

  #state: LifecycleState = 'active';
  readonly #doc: Y.Doc;
  readonly #awareness: awarenessProtocol.Awareness;
  readonly #context: SessionContext;

  readonly #sockets = new Set<SocketSession>();
  readonly #clientIdsBySocket = new Map<SocketSession, Set<number>>();
  readonly #writerIdBySocket = new Map<SocketSession, string>();

  #pending: PendingUpdate[] = [];
  #pendingBytes = 0;
  #flushingBytes = 0;
  #flushTimer: NodeJS.Timeout | null = null;
  #flushing: Promise<void> = Promise.resolve();

  #headSeq: bigint;
  #lastSnapshotSeq: bigint;
  #lastSnapshotAt: number;
  #lastWriter: { principalId: string; token: string } | null = null;

  #idleSince: number | null = null;

  /**
   * A snapshot the cadence did not ask for but the last reader leaving did.
   *
   * Set on the detach that empties the room and cleared by the next flush. It exists because a
   * snapshot is not only an optimisation any more: it is what publishes the document's outgoing
   * links and its searchable text, and both are things a person expects to be true the moment
   * they stop typing rather than whenever the two-hundred-update counter next rolls over.
   */
  #snapshotWhenIdle = false;

  /** Awareness changes are coalesced onto a short tick rather than fanned out per message. */
  readonly #awarenessDirty = new Set<number>();
  #awarenessTimer: NodeJS.Timeout | null = null;

  /** Which rate windows each socket has been refused in; three distinct ones is abuse. */
  readonly #abusedWindows = new Map<SocketSession, Set<number>>();

  #encodedBase: number;
  #bytesSinceEncode = 0;

  private constructor(
    itemId: string,
    docRow: ContentDocRow,
    tenantId: string,
    doc: Y.Doc,
    context: SessionContext,
    strategy: BodyKindStrategy,
  ) {
    this.itemId = itemId;
    this.docRow = docRow;
    this.tenantId = tenantId;
    this.strategy = strategy;
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
    strategy: BodyKindStrategy = noteStrategy,
  ): Promise<DocumentSession> {
    const doc = await withTenantScope(context.pool, scope, (sql) =>
      loadDocument(sql, scope.tenantId, docRow),
    );

    return new DocumentSession(itemId, docRow, scope.tenantId, doc, context, strategy);
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
   * snapshot plus every update applied since, with pending or currently flushing log bytes
   * counted separately because both copies remain resident. An estimate on purpose - counting
   * real heap would cost more than the number is worth - and always an overestimate, which is the
   * safe direction for a capacity decision.
   */
  get estimatedBytes(): number {
    return this.#encodedBase + this.#bytesSinceEncode + this.#pendingBytes + this.#flushingBytes;
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
      case MESSAGE_PERSISTED:
        void this.#persistBarrier(socket, frame.decoder);
        return;
      default:
        return;
    }
  }

  async #persistBarrier(socket: SocketSession, decoder: decoding.Decoder): Promise<void> {
    let barrierId: string;
    try {
      barrierId = decoding.readVarString(decoder);
    } catch {
      return;
    }
    if (barrierId.length === 0 || barrierId.length > 100) return;
    await this.flush();
    if (this.#sockets.has(socket) && socket.socket.readyState === 1) {
      socket.socket.send(encodePersisted(barrierId));
    }
  }

  #handleSync(socket: SocketSession, decoder: decoding.Decoder): void {
    let messageType: number;
    try {
      messageType = decoding.readVarUint(decoder);
    } catch {
      this.#refuse(socket, rejection('update_unreadable', 'The frame is not a sync message.'));
      return;
    }

    if (messageType === syncProtocol.messageYjsSyncStep1) {
      // A read: the client announces its state vector and receives what it is missing.
      // Readers and writers alike may ask.
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      try {
        syncProtocol.readSyncStep1(decoder, encoder, this.#doc);
      } catch {
        this.#refuse(socket, rejection('update_unreadable', 'The state vector does not decode.'));
        return;
      }
      socket.socket.send(encoding.toUint8Array(encoder));
      return;
    }

    if (
      messageType !== syncProtocol.messageYjsSyncStep2 &&
      messageType !== syncProtocol.messageYjsUpdate
    ) {
      return;
    }

    // Everything below carries writes, and every §17 row is checked before the resident
    // document is touched - a refused update leaves no trace to roll back.
    if (socket.mode !== 'write') {
      this.#refuse(socket, rejection('read_only', 'You may read this document but not change it.'));
      return;
    }

    let update: Uint8Array;
    try {
      update = decoding.readVarUint8Array(decoder);
    } catch {
      if (!this.#overRateLimit(socket))
        this.#refuse(socket, rejection('update_unreadable', 'The payload is not a Yjs update.'));
      return;
    }

    // An empty sync-step reply is a handshake, not an edit. Validating it against
    // a new, uninitialized note would refuse it and request the same reply forever.
    if (update.byteLength === 2 && update[0] === 0 && update[1] === 0) return;
    if (this.#overRateLimit(socket)) return;

    if (update.byteLength > LIMITS.updateBytes) {
      this.#context.log?.(
        `Refused an oversized update (${String(update.byteLength)} bytes) from principal ` +
          `${socket.authorization.principalId} on item ${this.itemId}.`,
      );
      this.#refuse(
        socket,
        rejection(
          'update_too_large',
          `An update may be at most ${String(LIMITS.updateBytes)} bytes; this one is ` +
            `${String(update.byteLength)}.`,
        ),
      );
      return;
    }

    const verdict = judgeCandidate(this.#doc, update, {
      strategy: this.strategy,
      pin: this.docRow.schema_version,
      diagnose: (reason) => {
        this.#context.log?.(
          `A ${this.strategy.kind} update from principal ` +
            `${socket.authorization.principalId} on item ${this.itemId} in tenant ` +
            `${this.tenantId} would not parse: ${reason}`,
        );
      },
    });
    if (!verdict.ok) {
      // The detail carries the two numbers that explain a pin refusal - what the merged
      // document needed and what the pin is - and without them nobody reading this log during a
      // deploy window can tell that the answer is "run the document migration".
      this.#context.log?.(
        `Refused an update (${verdict.refusal.code}) from principal ` +
          `${socket.authorization.principalId} on item ${this.itemId} in tenant ` +
          `${this.tenantId}: ${verdict.refusal.detail}`,
      );
      this.#refuse(socket, verdict.refusal);
      if (verdict.resync) {
        // The client's local state now diverges from the document the server will keep
        // serving. A fresh sync step 1 forces it to reconcile against reality instead of
        // silently editing a document nobody else has.
        this.beginSync(socket);
      }
      return;
    }

    // An accepted update lives twice until it is flushed: once in Yjs's resident history and
    // once in the pending persistence queue. This is the same deliberately conservative estimate
    // exposed by `estimatedBytes`, projected before mutating the document.
    const projectedBytes = this.estimatedBytes + verdict.persistedUpdateBytes * 2;
    if (this.#context.resizeResident?.(this, projectedBytes) === false) {
      this.#context.log?.(
        `Refused an update from principal ${socket.authorization.principalId} on item ` +
          `${this.itemId}: applying it would exceed this server's resident-memory capacity.`,
      );
      // The server has not applied the update, while the client still holds it locally. Closing
      // with the capacity code makes reconnect-and-resend the recovery path; keeping the socket
      // open would leave the two documents diverged with no honest acknowledgement available.
      this.detach(socket);
      socket.socket.close(
        CLOSE_CODES.atCapacity,
        'This server is at its resident-memory capacity. Retry shortly.',
      );
      return;
    }

    try {
      if (verdict.repair) {
        this.#applyWithRepair(socket, update);
      } else {
        Y.applyUpdate(this.#doc, update, socket);
      }
    } catch (cause) {
      // A judged Yjs update is deterministic, so this is a bug path. Restore the byte account
      // before surfacing it; otherwise one bad frame permanently consumes process capacity.
      this.#context.resizeResident?.(this, this.estimatedBytes);
      throw cause;
    }
  }

  /**
   * Applies an update that would have left the document under its structural floor, and puts the
   * floor back with it.
   *
   * **One transaction, and the origin is the socket, and both facts are load-bearing.** One
   * transaction, because Yjs emits a single update for it: the document is never observable
   * between the emptying and the mend, so nothing can flush, broadcast or snapshot the state that
   * would not parse. The socket as origin, because `#onDocUpdate` only queues an update for the
   * log when its origin is an attached socket - a server-invented origin would broadcast the mend
   * and never persist it, and the document would come back empty on the next load, which is the
   * bug this exists to close wearing a longer fuse.
   *
   * Attributing the mend to the principal whose update caused it is also the honest record: their
   * edit is what took the document to the floor, and the log should say so rather than invent a
   * second author.
   */
  #applyWithRepair(socket: SocketSession, update: Uint8Array): void {
    const before = Y.encodeStateVector(this.#doc);

    this.#doc.transact(() => {
      Y.applyUpdate(this.#doc, update, socket);
      this.strategy.repair?.(this.#doc);
    }, socket);

    // The broadcast in `#onDocUpdate` skips the origin, on the sound assumption that a client
    // already has what it just sent. That assumption is exactly false here: the mend is the one
    // part of this transaction the sender does not have, and without it the sender goes on
    // editing a document with no block in it and every later update is refused again. So the
    // delta since the state vector taken above goes back to it specifically - the mend, plus its
    // own update, which merges idempotently and costs nothing to re-receive.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(this.#doc, before));
    socket.socket.send(encoding.toUint8Array(encoder));

    this.#context.log?.(
      `Repaired an emptied ${this.strategy.kind} document from principal ` +
        `${socket.authorization.principalId} on item ${this.itemId} in tenant ` +
        `${this.tenantId}: the merge left it under the schema's structural floor, so the floor ` +
        'was restored and the update accepted rather than refused.',
    );
  }

  #refuse(socket: SocketSession, refusal: Rejection): void {
    socket.socket.send(encodeNotice(refusal));
  }

  /**
   * The backpressure ladder: over the window, each write is refused with a notice; a
   * principal who keeps pushing through three separate windows of refusals has a broken
   * client, not a busy one, and the socket closes.
   */
  #overRateLimit(socket: SocketSession): boolean {
    const rateWindow = this.#context.rateWindow;
    if (rateWindow === undefined) {
      return false;
    }

    if (!rateWindow.exceeded(socket.authorization.principalId, this.docRow.doc_id)) {
      return false;
    }

    // Distinct windows, pruned rather than cleared: a busy-loop client still gets some
    // messages through at each window's start, and forgiving the abuse for that would
    // mean never closing on exactly the client this exists for.
    const currentWindow = Math.floor(this.now() / LIMITS.windowMs);
    const windows = this.#abusedWindows.get(socket) ?? new Set<number>();
    this.#abusedWindows.set(socket, windows);
    windows.add(currentWindow);
    for (const window of windows) {
      if (window <= currentWindow - 3) {
        windows.delete(window);
      }
    }

    if (windows.size >= 3) {
      this.#context.log?.(
        `Closing a socket for sustained rate abuse: principal ` +
          `${socket.authorization.principalId} on item ${this.itemId}.`,
      );
      socket.socket.close(CLOSE_CODES.rateKilled, 'Sustained rate abuse.');
      return true;
    }

    this.#refuse(
      socket,
      rejection(
        'rate_limited',
        `At most ${String(LIMITS.updatesPerWindow)} updates per document per minute.`,
      ),
    );

    // The refused update is dropped, so this client now holds an edit the server does not and
    // nothing would ever re-send it - the socket stays open, and Yjs only re-reconciles on a
    // fresh sync. A sync step 1 is what makes the client notice and send it again, which turns
    // silent loss into a delay. Without it a person over the limit watches their work stay on
    // screen and finds it gone on reload.
    this.beginSync(socket);
    return true;
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
        // An empty queue does not mean nothing is owed. The last reader leaving asks for a
        // snapshot whatever the cadence says, and by then the queue is almost always already
        // empty - the 500 ms timer will have drained it seconds before the tab closed. Returning
        // here unconditionally, as this did, is what would leave a document's links and its
        // searchable text unpublished until the session was evicted five minutes later.
        await this.#maybeSnapshot();
        return;
      }
      this.#pending = [];
      const queueBytes = this.#pendingBytes;
      this.#pendingBytes = 0;
      this.#flushingBytes += queueBytes;
      this.#context.resizeResident?.(this, this.estimatedBytes);
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
      // The local queue remains strongly referenced throughout the database append. It leaves the
      // process-wide byte account only here, not when it moves out of `#pending` above.
      if (this.#flushingBytes > 0) {
        this.#flushingBytes = 0;
        this.#context.resizeResident?.(this, this.estimatedBytes);
      }
      release();
    }
  }

  async #maybeSnapshot(): Promise<void> {
    const due =
      this.#snapshotWhenIdle ||
      this.#headSeq - this.#lastSnapshotSeq >= BigInt(this.#context.config.snapshotEvery) ||
      (this.#headSeq > this.#lastSnapshotSeq &&
        this.now() - this.#lastSnapshotAt >= this.#context.config.snapshotIntervalMs);

    if (!due) {
      return;
    }

    // Cleared only once the write has actually been attempted. `#snapshotNow` does real I/O, and
    // clearing first meant a transient database error lost the request outright - on an idle
    // document `headSeq` never moves again, so "eventually" would have meant "at eviction".
    // Declining because the log has not moved is different, and is answered: that is a request
    // with nothing to do.
    try {
      await this.#snapshotNow();
    } finally {
      this.#snapshotWhenIdle = false;
    }
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
          itemId: this.docRow.item_id,
          seq,
          state: this.#doc,
          strategy: this.strategy,
        }),
    );

    if (written) {
      this.#lastSnapshotSeq = seq;
      this.#lastSnapshotAt = this.now();
      this.#encodedBase = Y.encodeStateAsUpdate(this.#doc).byteLength;
      this.#bytesSinceEncode = 0;
      this.#context.resizeResident?.(this, this.estimatedBytes);
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
    this.#abusedWindows.delete(socket);
    if (owned !== undefined && owned.size > 0) {
      awarenessProtocol.removeAwarenessStates(this.#awareness, [...owned], null);
    }

    if (this.#sockets.size === 0) {
      this.#idleSince = this.now();
      // A snapshot is what publishes a document's link edges and its searchable text, so the
      // moment the last person stops editing is exactly when they are owed. Without this the
      // cadence decides - every two hundred updates or every five minutes - and somebody who
      // writes a link and closes the tab watches the backlinks panel stay empty for both.
      this.#snapshotWhenIdle = true;

      // `flush` directly, not `scheduleFlush(0)`, and the difference is the whole fix.
      // `scheduleFlush` returns immediately when the pending queue is empty - which is right for
      // what it was written for, and wrong here: by the time the last tab closes the 500 ms timer
      // has almost always already drained the queue, so the snapshot this asks for was never
      // reached. Flush on disconnect is one of the three §17 triggers, and it still is; it now
      // also carries the snapshot request, and `flush` handles an empty queue itself.
      void this.flush();
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

  /**
   * Forgets an envelope Core has already deleted. Nothing may be flushed: the database
   * cascade is authoritative, and replaying pending draft updates would only create noise
   * against a body that no longer exists.
   */
  invalidate(): void {
    this.#state = 'unloaded';
    this.#pending = [];
    this.#pendingBytes = 0;
    this.#flushingBytes = 0;
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

/**
 * What a candidate update is judged against.
 *
 * An options object rather than a tail of defaulted positionals: `ceilings` defaults to the
 * strategy's own, so reaching `pin` past it meant passing the default explicitly at the one
 * call site that needed to - which is the shape that guarantees the next parameter gets
 * appended too.
 */
export interface CandidateJudgement {
  readonly strategy?: BodyKindStrategy;
  readonly ceilings?: { nodes: number; bytes: number };

  /** The document's stored `schema_version`. Defaults to what this build speaks. */
  readonly pin?: number;

  /**
   * Told why, when the merged document will not parse.
   *
   * Separate from the refusal the client receives, which stays deliberately vague. This is for
   * the operator log, and without it `document_does_not_parse` names a symptom and nothing else -
   * which is exactly the position somebody is in when a document silently will not save.
   */
  readonly diagnose?: (reason: string) => void;
}

/**
 * What became of a candidate update: apply it, or refuse it - and maybe force a resync.
 *
 * `repair` on the accepting side is the one case where applying the update verbatim is not
 * enough: the merged document fell through its kind's structural floor, and the caller must put
 * the floor back in the same breath as it applies the update. It is reported rather than done
 * here because this function is deliberately free of side effects on the resident document -
 * everything it learns, it learns from throwaway forks.
 */
export type CandidateVerdict =
  | {
      readonly ok: true;
      readonly repair: boolean;
      readonly persistedUpdateBytes: number;
    }
  | { readonly ok: false; readonly refusal: Rejection; readonly resync: boolean };

/**
 * Judges a candidate update against a throwaway fork of the resident document, so a
 * refusal leaves the resident state untouched - the same validate-by-applying stance the
 * HTTP path takes, minus the per-request reload it had to pay for it.
 *
 * The ceiling rule is §17's: a document over its node or byte ceiling refuses growth and
 * allows shrinkage, because the one edit that must always go through on an oversized
 * document is the delete that fixes it. A Yjs update can insert and delete at once, so
 * "growth" is measured on the outcome: over the ceiling *and* bigger than before.
 *
 * The pin rule has no such asymmetry: an update that would take the document past its
 * stored `schema_version` is refused outright, because every client that speaks the pinned
 * version has been promised this document opens, and there is no shrinking edit that a
 * newer node makes necessary.
 */
export function judgeCandidate(
  resident: Y.Doc,
  update: Uint8Array,
  judgement: CandidateJudgement = {},
): CandidateVerdict {
  const strategy = judgement.strategy ?? noteStrategy;
  const ceilings = judgement.ceilings ?? strategy.ceilings;
  const pin = judgement.pin ?? SCHEMA_VERSION;

  let fork: Y.Doc;
  try {
    fork = forkWith(resident, update);
  } catch (cause) {
    return {
      ok: false,
      refusal: rejection(
        'update_unreadable',
        cause instanceof Error ? cause.message : 'The payload is not a Yjs update.',
      ),
      resync: false,
    };
  }

  let persistedUpdateBytes = update.byteLength;
  let after = strategy.measure(fork);
  fork.destroy();

  // The floor, before the refusal. A merged document that holds nothing is the one unparseable
  // outcome a client can reach without having written anything wrong - the Yjs undo manager
  // unwinds below the schema's `block+` minimum, which ProseMirror editing itself cannot do - and
  // refusing it strands the client in a state it cannot edit its way out of. So the floor is put
  // back and the update accepted, rather than the person's edit being dropped.
  //
  // A fresh fork, because measuring consumed the one above for the same reason the diagnosis
  // below rebuilds its own: reading a fragment as prose drops what the schema does not know from
  // the Yjs document itself, so a measured fork can no longer be asked anything. Every fork here
  // is thrown away; the resident is not touched by anything in this function, which is what lets
  // the caller treat a refusal as having left no trace.
  //
  // **Gated on the resident having parsed.** Without that, "the merged document has no blocks"
  // also describes an update belonging to an entirely different body kind - a canvas keeps its
  // scene in a Y.Map and leaves the prose fragment empty - and the backstop would answer a
  // client talking to the wrong document by silently writing it an empty paragraph and accepting
  // the update. Requiring the resident to be a document of this kind already is what makes this
  // "a valid document fell through its floor" rather than "anything that does not parse".
  let repair = false;
  if (after === null && strategy.repair !== undefined && parsesAlone(resident, strategy)) {
    try {
      const mended = forkWith(resident, update);
      try {
        if (strategy.repair(mended)) {
          // Re-measured, never assumed: a repair is honoured only if it actually produced a
          // document this build could open again. Anything else - a fault the floor was not the
          // cause of, a repaired document now over its schema pin - falls through to the refusal
          // with the diagnosis intact, which is the outcome that tells an operator the truth.
          const mendedPersistedUpdateBytes = Y.encodeStateAsUpdate(
            mended,
            Y.encodeStateVector(resident),
          ).byteLength;
          const mendedMeasurement = strategy.measure(mended);
          if (mendedMeasurement !== null) {
            after = mendedMeasurement;
            repair = true;
            persistedUpdateBytes = mendedPersistedUpdateBytes;
          }
        }
      } finally {
        mended.destroy();
      }
    } catch {
      // A failed repair attempt is not a second failure mode to report; it simply means the
      // update stays refused, which is what it already was.
    }
  }

  if (after === null) {
    // A second fork, built from the same two inputs, because measuring consumed the first: reading
    // a fragment as prose drops the nodes the schema does not know, so the fork can no longer say
    // what was in it. The resident is untouched - only the fork was measured - so rebuilding is
    // exact, and it costs nothing on the path where an update is accepted.
    if (judgement.diagnose !== undefined && strategy.explain !== undefined) {
      const pristine = new Y.Doc();
      try {
        Y.applyUpdate(pristine, Y.encodeStateAsUpdate(resident));
        Y.applyUpdate(pristine, update);
        const reason = strategy.explain(pristine);

        // And what the update carried *on its own*, which the merged reading cannot show. A client
        // sending a well-formed document into an empty one and a client sending nothing at all
        // both produce an empty merge, and they are opposite problems: the first means the server
        // is losing something, the second means the client never had it.
        const alone = new Y.Doc();
        let carried = 'unreadable';
        try {
          Y.applyUpdate(alone, update);
          carried = strategy.explain(alone) === null ? 'a document that parses' : 'nothing usable';
        } catch {
          carried = 'an update that does not decode';
        } finally {
          alone.destroy();
        }

        if (reason !== null) {
          judgement.diagnose(`${reason}; the update by itself carried ${carried}`);
        }
      } catch {
        // The diagnosis is a courtesy; failing to produce one must not change the verdict.
      } finally {
        pristine.destroy();
      }
    }
    return {
      ok: false,
      refusal: rejection(
        'document_does_not_parse',
        'Applying this update would produce a document the schema rejects.',
      ),
      resync: true,
    };
  }

  if (after.schemaVersion > pin) {
    return {
      ok: false,
      refusal: rejection(
        'document_above_schema_pin',
        `This update would need schema version ${String(after.schemaVersion)} to open, and ` +
          `the document is pinned to ${String(pin)}. Refusing to write a document older ` +
          'clients have been told they can read. Run the document schema migration first.',
      ),
      // No resync. The client's local state is not wrong - this build would happily keep it -
      // so forcing it to reconcile against the server would discard a legitimate edit and
      // teach the person nothing. The refusal notice is the honest answer.
      resync: false,
    };
  }

  if (after.nodes > ceilings.nodes || after.bytes > ceilings.bytes) {
    const before = strategy.measure(resident);
    const grew = before === null || after.nodes > before.nodes || after.bytes > before.bytes;

    if (grew) {
      return {
        ok: false,
        refusal:
          after.nodes > ceilings.nodes
            ? rejection(
                'document_too_many_nodes',
                `A document may hold at most ${String(ceilings.nodes)} nodes; this one ` +
                  `would hold ${String(after.nodes)}.`,
              )
            : rejection(
                'document_too_large',
                `A document may be at most ${String(ceilings.bytes)} bytes; this one ` +
                  `would be ${String(after.bytes)}.`,
              ),
        resync: true,
      };
    }
  }

  return { ok: true, repair, persistedUpdateBytes };
}

/**
 * Whether the resident document, as it stands and before any candidate update, is one this
 * strategy can already read.
 *
 * Through a copy rather than by measuring the resident, because measuring is not read-only:
 * reading a fragment as prose drops the nodes the schema does not know from the Yjs document
 * itself. Asking the resident directly would mutate live state to answer a question about it,
 * and on exactly the documents where the answer matters most.
 */
function parsesAlone(resident: Y.Doc, strategy: BodyKindStrategy): boolean {
  const copy = new Y.Doc();
  try {
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(resident));
    return strategy.measure(copy) !== null;
  } catch {
    return false;
  } finally {
    copy.destroy();
  }
}

/**
 * A throwaway copy of the resident document with the candidate update applied.
 *
 * Throws when the update does not decode, which is the caller's `update_unreadable`. Every caller
 * destroys what it gets back: these are short-lived and the resident document must never be
 * reachable from one.
 */
function forkWith(resident: Y.Doc, update: Uint8Array): Y.Doc {
  const fork = new Y.Doc();
  try {
    Y.applyUpdate(fork, Y.encodeStateAsUpdate(resident));
    Y.applyUpdate(fork, update);
  } catch (cause) {
    fork.destroy();
    throw cause;
  }
  return fork;
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
