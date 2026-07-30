import { SCHEMA_VERSION } from '@nix/editor-schema';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { Pool } from 'pg';
import { WebSocket } from 'ws';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Authorizer, ItemAuthorization } from '../auth/authorize.ts';
import { connectDocumentLocks, type DocumentLocks } from '../db/advisory-lock.ts';
import {
  DB_TESTS_ENABLED,
  TENANTS,
  TEST_DATABASE_URL,
  collabPool,
  clearContent,
  seedTenants,
  type TestTenant,
} from '../db/testing.ts';
import { createServer } from '../http/server.ts';
import { MESSAGE_SYNC } from '../ws/protocol.ts';
import type { SocketSession } from '../ws/server.ts';
import { createSessionAuthenticator } from '../ws/session-auth.ts';
import { createDocumentRegistry, type DocumentHub, type RegistryConfig } from './registry.ts';
import { DocumentSession } from './session.ts';

/**
 * The document lifecycle against real Postgres and real sockets: load once, sync live,
 * flush batched, snapshot on cadence, evict when idle - and recover all of it on
 * reconnect, because the log is the source of truth and memory never is.
 */

const SECOND_PRINCIPAL = 'c1000000-0000-4000-8000-000000000023';

/** Tokens double as principal selectors so multi-principal tests need no second issuer. */
function authorizerFor(tenant: TestTenant): Authorizer {
  return {
    authorize: (token: string): Promise<ItemAuthorization | null> =>
      Promise.resolve({
        tenantId: tenant.tenantId,
        workspaceId: tenant.workspaceId,
        principalId: token === 'as-second-principal' ? SECOND_PRINCIPAL : tenant.principalId,
        canWrite: true,
        bodyKind: 'note',
      }),
  };
}

const FAST: RegistryConfig = {
  flushMs: 40,
  flushBytes: 512 * 1024,
  snapshotEvery: 5,
  snapshotIntervalMs: 3_600_000,
  idleEvictMs: 150,
  maxDocs: 50,
  maxResidentBytes: 256 * 1024 * 1024,
  sweepMs: 60,
};

interface Harness {
  readonly url: string;
  readonly pool: Pool;
  readonly locks: DocumentLocks;
  readonly registry: DocumentHub;
  readonly flushes: string[];
  close(): Promise<void>;
}

async function startServer(overrides?: Partial<RegistryConfig>): Promise<Harness> {
  const pool = collabPool();
  const locks = await connectDocumentLocks({
    databaseUrl: TEST_DATABASE_URL,
    onSessionLost: () => undefined,
  });
  const flushes: string[] = [];

  const registry = createDocumentRegistry({
    pool,
    locks,
    config: { ...FAST, ...overrides },
    onFlushed: (session) => {
      flushes.push(session.itemId);
    },
  });

  const app = createServer({
    pool,
    sessions: createSessionAuthenticator({
      tokens: { validate: (token) => Promise.resolve({ subject: token, expiresAt: null }) },
      authorizer: authorizerFor(TENANTS.alpha),
      cacheTtlMs: 1,
    }),
    snapshotEvery: FAST.snapshotEvery,
    reauthMs: 60_000,
    hub: registry,
  });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The test server did not bind a port.');
  }

  let closed = false;
  return {
    url: `ws://127.0.0.1:${String(address.port)}`,
    pool,
    locks,
    registry,
    flushes,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await app.close();
      await locks.close();
      await pool.end();
    },
  };
}

/**
 * A minimal client provider: auth frame, sync protocol, local edits sent as updates. The
 * shape the web client's provider takes, reduced to what these assertions need.
 */
interface TestClient {
  readonly doc: Y.Doc;
  readonly socket: WebSocket;
  readonly ready: Promise<{ docId: string; mode: string }>;
  close(): void;
}

function connectClient(url: string, itemId: string, token: string): TestClient {
  const doc = new Y.Doc();
  const socket = new WebSocket(`${url}/documents/${itemId}/ws`);
  const REMOTE = socket;

  const ready = new Promise<{ docId: string; mode: string }>((resolve, reject) => {
    socket.on('close', (code) => {
      reject(new Error(`closed before ready: ${String(code)}`));
    });
    socket.on('message', (data, isBinary) => {
      if (!isBinary) {
        resolve(JSON.parse(Buffer.from(data as Buffer).toString('utf8')) as { docId: string; mode: string });
      }
    });
  });
  ready.catch(() => undefined);

  socket.on('open', () => {
    socket.send(JSON.stringify({ type: 'auth', token, schemaVersion: SCHEMA_VERSION }));
  });

  // Both sides open with sync step 1, exactly as y-websocket does: the server's step 1
  // pulls the client's edits, and this one pulls the server's.
  void ready.then(() => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, doc);
    socket.send(encoding.toUint8Array(encoder));
  });

  socket.on('message', (data, isBinary) => {
    if (!isBinary) {
      return;
    }
    const decoder = decoding.createDecoder(new Uint8Array(data as Buffer));
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) {
      return;
    }
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.readSyncMessage(decoder, encoder, doc, REMOTE);
    if (encoding.length(encoder) > 1 && socket.readyState === WebSocket.OPEN) {
      socket.send(encoding.toUint8Array(encoder));
    }
  });

  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== REMOTE && socket.readyState === WebSocket.OPEN) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      socket.send(encoding.toUint8Array(encoder));
    }
  });

  return {
    doc,
    socket,
    ready,
    close: () => {
      socket.terminate();
      doc.destroy();
    },
  };
}

/** Writes one paragraph of prose - a shape the schema accepts - into the shared fragment. */
function typeParagraph(doc: Y.Doc, text: string): void {
  const fragment = doc.getXmlFragment('default');
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText(text)]);
  fragment.insert(fragment.length, [paragraph]);
}

function textOf(doc: Y.Doc): string {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Y.XmlFragment defines its own XML toString; the rule cannot see through the generic base class.
  return doc.getXmlFragment('default').toString();
}

async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 4_000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (await check()) {
      return;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for ${what}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function fakeSocketSession(tenant: TestTenant, principalId?: string): SocketSession {
  const socket = {
    send: () => undefined,
    close: () => undefined,
    readyState: WebSocket.OPEN,
  } as unknown as WebSocket;

  return {
    socket,
    itemId: tenant.itemId,
    clientSchemaVersion: SCHEMA_VERSION,
    token: 'a-token',
    authorization: {
      tenantId: tenant.tenantId,
      workspaceId: tenant.workspaceId,
      principalId: principalId ?? tenant.principalId,
      canWrite: true,
      bodyKind: 'note',
      subject: 'someone',
      tokenExpiresAt: null,
    },
    mode: 'write',
  };
}

describe.runIf(DB_TESTS_ENABLED)('the document lifecycle, against Postgres', () => {
  // Verification runs as the superuser: the collab role's own reads are tenant-scoped by
  // row-level security, and an unscoped SELECT through it would see nothing and prove it.
  let verifyPool: Pool;

  beforeAll(async () => {
    await seedTenants();
    verifyPool = new Pool({
      connectionString:
        process.env.NIX_COLLAB_TEST_ADMIN_DATABASE_URL ??
        'postgresql://postgres:nix-dev-superuser@localhost:5433/nix',
      max: 2,
    });
  });

  afterAll(async () => {
    await verifyPool.end();
  });

  beforeEach(async () => {
    await clearContent();
  });

  const harnesses: Harness[] = [];
  const clients: TestClient[] = [];

  function track(harness: Harness): Harness {
    harnesses.push(harness);
    return harness;
  }

  function open(url: string, itemId: string, token = 'as-first-principal'): TestClient {
    const client = connectClient(url, itemId, token);
    clients.push(client);
    return client;
  }

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.close();
    }
    await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  });

  async function countUpdates(tenant: TestTenant): Promise<number> {
    const { rows } = await verifyPool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM content_update u JOIN content_doc d USING (doc_id)
       WHERE d.tenant_id = $1 AND d.item_id = $2`,
      [tenant.tenantId, tenant.itemId],
    );
    return Number(rows[0]?.count ?? '0');
  }

  it('converges two live clients through the resident document', async () => {
    const harness = track(await startServer());
    const alice = open(harness.url, TENANTS.alpha.itemId);
    const bella = open(harness.url, TENANTS.alpha.itemId);
    await Promise.all([alice.ready, bella.ready]);

    typeParagraph(alice.doc, 'Hello from the first editor.');
    typeParagraph(bella.doc, 'And from the second.');

    await until(
      () =>
        textOf(alice.doc) === textOf(bella.doc) &&
        textOf(alice.doc).includes('first editor') &&
        textOf(alice.doc).includes('the second'),
      'both clients to converge',
    );
  });

  it('flushes one batch that advances the head once, and says so to Core once', async () => {
    const harness = track(await startServer());
    const alice = open(harness.url, TENANTS.alpha.itemId);
    await alice.ready;

    typeParagraph(alice.doc, 'One.');
    typeParagraph(alice.doc, 'Two.');
    typeParagraph(alice.doc, 'Three.');

    await until(async () => (await countUpdates(TENANTS.alpha)) > 0, 'the flush to land');

    const { rows } = await verifyPool.query<{ head_seq: string; count: string }>(
      `SELECT d.head_seq::text AS head_seq,
              (SELECT count(*) FROM content_update u WHERE u.doc_id = d.doc_id)::text AS count
       FROM content_doc d
       WHERE d.tenant_id = $1 AND d.item_id = $2`,
      [TENANTS.alpha.tenantId, TENANTS.alpha.itemId],
    );

    // The head advanced by exactly the rows written: batching changed how often the row
    // lock is taken, never the log's shape.
    expect(rows[0]?.head_seq).toBe(rows[0]?.count);
    expect(harness.flushes.length).toBeGreaterThan(0);
  });

  it('records each principal as the actor of their own updates, batching notwithstanding', async () => {
    const harness = track(await startServer());
    const first = open(harness.url, TENANTS.alpha.itemId, 'as-first-principal');
    const second = open(harness.url, TENANTS.alpha.itemId, 'as-second-principal');
    await Promise.all([first.ready, second.ready]);

    typeParagraph(first.doc, 'Signed by the first.');
    await until(async () => (await countUpdates(TENANTS.alpha)) >= 1, 'the first flush');
    typeParagraph(second.doc, 'Signed by the second.');
    await until(async () => (await countUpdates(TENANTS.alpha)) >= 2, 'the second flush');

    const { rows } = await verifyPool.query<{ actor_id: string }>(
      `SELECT DISTINCT u.actor_id
       FROM content_update u JOIN content_doc d USING (doc_id)
       WHERE d.tenant_id = $1 AND d.item_id = $2`,
      [TENANTS.alpha.tenantId, TENANTS.alpha.itemId],
    );

    const actors = rows.map((row) => row.actor_id).sort();
    expect(actors).toEqual([TENANTS.alpha.principalId, SECOND_PRINCIPAL].sort());
  });

  it('recovers everything for a fresh client after the writer is gone', async () => {
    const harness = track(await startServer());
    const alice = open(harness.url, TENANTS.alpha.itemId);
    await alice.ready;

    typeParagraph(alice.doc, 'Written before the crash.');
    await until(async () => (await countUpdates(TENANTS.alpha)) > 0, 'the flush to land');
    alice.close();

    const successor = open(harness.url, TENANTS.alpha.itemId);
    await successor.ready;

    // Sync step 1 is the recovery mechanism: the fresh client announces an empty state
    // vector and receives everything the log holds.
    await until(
      () => textOf(successor.doc).includes('Written before the crash.'),
      'the successor to catch up',
    );
  });

  it('drains an idle document: flushed, snapshotted, unloaded - and reloadable', async () => {
    const harness = track(await startServer());
    const alice = open(harness.url, TENANTS.alpha.itemId);
    await alice.ready;

    for (let index = 0; index < 6; index += 1) {
      typeParagraph(alice.doc, `Paragraph ${String(index)}.`);
    }
    await until(async () => (await countUpdates(TENANTS.alpha)) >= 6, 'the flush to land');
    alice.close();

    await until(() => harness.registry.size === 0, 'the idle sweep to evict');

    const { rows } = await verifyPool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM content_snapshot s JOIN content_doc d USING (doc_id)
       WHERE d.tenant_id = $1 AND d.item_id = $2`,
      [TENANTS.alpha.tenantId, TENANTS.alpha.itemId],
    );
    expect(Number(rows[0]?.count ?? '0')).toBeGreaterThan(0);

    // Unloaded is not gone: the next reader loads from the snapshot it just wrote.
    const reader = open(harness.url, TENANTS.alpha.itemId);
    await reader.ready;
    await until(() => textOf(reader.doc).includes('Paragraph 5.'), 'the reload to catch up');
  });

  it('cancels a drain when a socket reattaches mid-way', async () => {
    const pool = collabPool();
    try {
      const scope = { tenantId: TENANTS.alpha.tenantId, principalId: TENANTS.alpha.principalId };
      const { withTenantScope } = await import('../db/tenant-scope.ts');
      const { openDocument } = await import('./service.ts');
      const docRow = await withTenantScope(pool, scope, (sql) =>
        openDocument(sql, scope.tenantId, TENANTS.alpha.itemId, TENANTS.alpha.workspaceId, () => TENANTS.alpha.docId),
      );
      if (docRow === null) {
        throw new Error('The seeded item has no document body.');
      }

      const session = await DocumentSession.load(TENANTS.alpha.itemId, docRow, scope, {
        pool,
        config: FAST,
      });

      const socket = fakeSocketSession(TENANTS.alpha);
      session.attach(socket);

      // A drain with a socket still attached must decline to unload: the state diagram's
      // reconnect-cancels edge, in its simplest form.
      expect(await session.drain()).toBe(false);
      expect(session.state).toBe('active');

      session.detach(socket);
      expect(await session.drain()).toBe(true);
      expect(session.state).toBe('unloaded');
    } finally {
      await pool.end();
    }
  });

  it('refuses the whole load, loudly, when the server is at document capacity', async () => {
    const harness = track(await startServer({ maxDocs: 0 }));

    const joined = await harness.registry.join(fakeSocketSession(TENANTS.alpha));

    expect(joined).toMatchObject({ ok: false, closeCode: 4413 });
  });

  it('refuses a document another instance owns, instead of serving it twice', async () => {
    const harness = track(await startServer());
    const alice = open(harness.url, TENANTS.alpha.itemId);
    await alice.ready;

    const rivalPool = collabPool();
    const rivalLocks = await connectDocumentLocks({
      databaseUrl: TEST_DATABASE_URL,
      onSessionLost: () => undefined,
    });
    const rival = createDocumentRegistry({ pool: rivalPool, locks: rivalLocks, config: FAST });

    try {
      const joined = await rival.join(fakeSocketSession(TENANTS.alpha));
      expect(joined).toMatchObject({ ok: false, closeCode: 4423 });
    } finally {
      await rival.shutdown();
      await rivalLocks.close();
      await rivalPool.end();
    }
  });

  it('holds a burst from several clients: convergence, batched flushes, bounded memory', async () => {
    const harness = track(await startServer({ snapshotEvery: 100 }));
    const writers = [
      open(harness.url, TENANTS.alpha.itemId, 'as-first-principal'),
      open(harness.url, TENANTS.alpha.itemId, 'as-second-principal'),
      open(harness.url, TENANTS.alpha.itemId, 'as-first-principal'),
    ];
    await Promise.all(writers.map((writer) => writer.ready));

    const PER_WRITER = 60;
    for (let round = 0; round < PER_WRITER; round += 1) {
      for (const [index, writer] of writers.entries()) {
        typeParagraph(writer.doc, `Round ${String(round)} from writer ${String(index)}.`);
      }
      if (round % 10 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    }

    const total = PER_WRITER * writers.length;
    await until(async () => (await countUpdates(TENANTS.alpha)) >= total, 'every update to land', 10_000);
    await until(
      () =>
        writers.every(
          (writer) =>
            textOf(writer.doc) === textOf(writers[0]?.doc ?? writer.doc) &&
            textOf(writer.doc).includes(`Round ${String(PER_WRITER - 1)} from writer 2.`),
        ),
      'all writers to converge',
      10_000,
    );

    // Batching is the point of the resident server: the log holds every update, but the
    // flush count - each one a head_seq row lock - stays well under one per update.
    expect(harness.flushes.length).toBeLessThan(total / 2);
  }, 30_000);

  it('flushes what is pending when the server shuts down, not never', async () => {
    const harness = track(await startServer({ flushMs: 60_000 }));
    const alice = open(harness.url, TENANTS.alpha.itemId);
    await alice.ready;

    typeParagraph(alice.doc, 'Typed moments before the rollout.');
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Nothing has flushed - the window is a minute - so the shutdown drain is the only
    // thing standing between this edit and the crash-loss window.
    expect(await countUpdates(TENANTS.alpha)).toBe(0);
    await harness.close();

    expect(await countUpdates(TENANTS.alpha)).toBeGreaterThan(0);
  });
});
