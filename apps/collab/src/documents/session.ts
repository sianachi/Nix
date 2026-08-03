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
  MESSAGE_SYNC,
  CLOSE_CODES,
  encodeNotice,
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

    if (this.#overRateLimit(socket)) {
      return;
    }

    let update: Uint8Array;
    try {
      update = decoding.readVarUint8Array(decoder);
    } catch {
      this.#refuse(socket, rejection('update_unreadable', 'The payload is not a Yjs update.'));
      return;
    }

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

    Y.applyUpdate(this.#doc, update, socket);
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
          strategy: this.strategy,
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
    this.#abusedWindows.delete(socket);
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
}

/** What became of a candidate update: apply it, or refuse it - and maybe force a resync. */
export type CandidateVerdict =
  | { readonly ok: true }
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

  const fork = new Y.Doc();
  try {
    Y.applyUpdate(fork, Y.encodeStateAsUpdate(resident));
    Y.applyUpdate(fork, update);
  } catch (cause) {
    fork.destroy();
    return {
      ok: false,
      refusal: rejection(
        'update_unreadable',
        cause instanceof Error ? cause.message : 'The payload is not a Yjs update.',
      ),
      resync: false,
    };
  }

  const after = strategy.measure(fork);
  fork.destroy();
  if (after === null) {
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

  return { ok: true };
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
