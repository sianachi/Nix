import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import type { DocumentLocks } from '../db/advisory-lock.ts';
import { withTenantScope } from '../db/tenant-scope.ts';
import type { CollabMetrics } from '../metrics.ts';
import { CLOSE_CODES } from '../ws/protocol.ts';
import type { JoinResult, SessionHub, SocketSession } from '../ws/server.ts';
import type { RateWindow } from './limits.ts';
import { openDocument } from './service.ts';
import { DocumentSession, type SessionConfig } from './session.ts';

export interface RegistryConfig extends SessionConfig {
  /** How many documents may be resident at once. Past it, loads are refused, honestly. */
  readonly maxDocs: number;

  /** How many estimated resident bytes the process may hold. The second capacity wall. */
  readonly maxResidentBytes: number;

  /** How long a document may sit without sockets before it drains. */
  readonly idleEvictMs: number;

  /** How often the idle sweep runs. */
  readonly sweepMs: number;
}

export interface DocumentHub extends SessionHub {
  /** Documents currently resident. For tests and gauges. */
  readonly size: number;

  /** Drains everything: final flushes, snapshots, released claims. For shutdown. */
  shutdown(): Promise<void>;

  /**
   * Drops everything without owning it any longer: the lock session died, so every claim
   * this process held is already released and another instance may own these documents.
   * Best-effort flush, then sockets close with `ownedElsewhere` so clients re-route.
   */
  dropAll(): Promise<void>;
}

/**
 * The registry: which documents are resident, and the front door for making one so.
 *
 * Everything scale-shaped funnels through `join`: the capacity walls (documents and
 * bytes), the ownership claim, the single load per document however many sockets arrive
 * at once, and the schema pin. Past the door, `DocumentSession` does the work; the
 * registry only decides what is allowed to exist.
 */
export function createDocumentRegistry(deps: {
  pool: Pool;
  locks: DocumentLocks;
  config: RegistryConfig;
  metrics?: CollabMetrics | undefined;
  newDocId?: (() => string) | undefined;
  onFlushed?: ((session: DocumentSession) => void) | undefined;
  rateWindow?: RateWindow | undefined;
  log?: ((message: string) => void) | undefined;
}): DocumentHub {
  const sessions = new Map<string, DocumentSession>();
  const loading = new Map<string, Promise<DocumentSession | null>>();
  const newDocId = deps.newDocId ?? randomUUID;

  const sweeper = setInterval(() => {
    void sweep();
  }, deps.config.sweepMs);
  sweeper.unref();

  function totalEstimatedBytes(): number {
    let total = 0;
    for (const session of sessions.values()) {
      total += session.estimatedBytes;
    }
    return total;
  }

  function publishGauges(): void {
    deps.metrics?.loadedDocuments.set(sessions.size);
    deps.metrics?.residentBytes.set(totalEstimatedBytes());
  }

  async function sweep(): Promise<void> {
    const deadline = Date.now() - deps.config.idleEvictMs;
    for (const [itemId, session] of sessions) {
      const idleSince = session.idleSince;
      if (idleSince === null || idleSince > deadline || session.state === 'draining') {
        continue;
      }

      const unloaded = await session.drain();
      if (unloaded) {
        sessions.delete(itemId);
        await deps.locks.release(session.docRow.doc_id);
      }
    }
    publishGauges();
  }

  async function acquire(socket: SocketSession): Promise<DocumentSession | JoinResult> {
    const existing = sessions.get(socket.itemId);
    if (existing !== undefined && existing.state !== 'unloaded') {
      return existing;
    }

    const inFlight = loading.get(socket.itemId);
    if (inFlight !== undefined) {
      const settled = await inFlight;
      return (
        settled ?? {
          ok: false,
          closeCode: CLOSE_CODES.notFound,
          reason: 'No document body is visible.',
        }
      );
    }

    // Both capacity walls are checked before any work is spent on the load, and the
    // refusal is loud: §17's honest-degradation rule is that at capacity the interface
    // says so rather than silently degrading everyone already here.
    if (sessions.size >= deps.config.maxDocs) {
      return {
        ok: false,
        closeCode: CLOSE_CODES.atCapacity,
        reason: 'This server is at its resident-document capacity. Retry shortly.',
      };
    }
    if (totalEstimatedBytes() >= deps.config.maxResidentBytes) {
      return {
        ok: false,
        closeCode: CLOSE_CODES.atCapacity,
        reason: 'This server is at its resident-memory capacity. Retry shortly.',
      };
    }

    const load = (async (): Promise<DocumentSession | null> => {
      const { authorization } = socket;
      const scope = { tenantId: authorization.tenantId, principalId: authorization.principalId };

      const docRow = await withTenantScope(deps.pool, scope, (sql) =>
        openDocument(sql, scope.tenantId, socket.itemId, authorization.workspaceId, newDocId),
      );
      if (docRow === null) {
        return null;
      }

      const claimed = await deps.locks.acquire(docRow.doc_id);
      if (!claimed) {
        throw new OwnedElsewhere(docRow.doc_id);
      }

      try {
        const session = await DocumentSession.load(socket.itemId, docRow, scope, {
          pool: deps.pool,
          config: deps.config,
          metrics: deps.metrics,
          onFlushed: deps.onFlushed,
          rateWindow: deps.rateWindow,
          log: deps.log,
        });
        sessions.set(socket.itemId, session);
        return session;
      } catch (cause) {
        await deps.locks.release(docRow.doc_id);
        throw cause;
      }
    })();

    loading.set(socket.itemId, load.catch(() => null));
    try {
      const session = await load;
      if (session === null) {
        return {
          ok: false,
          closeCode: CLOSE_CODES.notFound,
          reason: 'No document body is visible.',
        };
      }
      return session;
    } catch (cause) {
      if (cause instanceof OwnedElsewhere) {
        return {
          ok: false,
          closeCode: CLOSE_CODES.ownedElsewhere,
          reason: 'Another instance owns this document.',
        };
      }
      throw cause;
    } finally {
      loading.delete(socket.itemId);
    }
  }

  return {
    get size(): number {
      return sessions.size;
    },

    async join(socket: SocketSession): Promise<JoinResult> {
      const acquired = await acquire(socket);
      if (!(acquired instanceof DocumentSession)) {
        return acquired;
      }

      if (socket.clientSchemaVersion < acquired.docRow.schema_version) {
        return {
          ok: false,
          closeCode: CLOSE_CODES.schemaMismatch,
          reason: `This document is pinned to schema version ${String(acquired.docRow.schema_version)}.`,
        };
      }

      acquired.attach(socket);
      publishGauges();
      return { ok: true, docId: acquired.docRow.doc_id, schemaVersion: acquired.docRow.schema_version };
    },

    ready(socket: SocketSession): void {
      sessions.get(socket.itemId)?.beginSync(socket);
    },

    handleMessage(socket: SocketSession, data: Uint8Array): void {
      sessions.get(socket.itemId)?.handleMessage(socket, data);
    },

    leave(socket: SocketSession): void {
      sessions.get(socket.itemId)?.detach(socket);
      publishGauges();
    },

    async shutdown(): Promise<void> {
      clearInterval(sweeper);
      for (const [itemId, session] of [...sessions]) {
        session.closeSockets(CLOSE_CODES.draining, 'The server is shutting down.');
        await session.drain();
        sessions.delete(itemId);
        await deps.locks.release(session.docRow.doc_id);
      }
      publishGauges();
    },

    async dropAll(): Promise<void> {
      clearInterval(sweeper);
      for (const [itemId, session] of [...sessions]) {
        sessions.delete(itemId);
        // Flushing is still safe - sequence allocation serialises on the head_seq row
        // lock whoever owns the document - and it is the last chance these updates get.
        await session.flush().catch(() => undefined);
        session.closeSockets(CLOSE_CODES.ownedElsewhere, 'This server lost its ownership session.');
      }
      publishGauges();
    },
  };
}

class OwnedElsewhere extends Error {
  constructor(docId: string) {
    super(`Another instance holds the claim on document ${docId}.`);
    this.name = 'OwnedElsewhere';
  }
}
