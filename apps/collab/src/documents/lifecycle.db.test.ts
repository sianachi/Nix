import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { connectDocumentLocks } from '../db/advisory-lock.ts';
import {
  DB_TESTS_ENABLED,
  TENANTS,
  TEST_DATABASE_URL,
  collabPool,
  clearContent,
  seedTenants,
} from '../db/testing.ts';
import { withTenantScope } from '../db/tenant-scope.ts';
import { createDocumentRegistry } from './registry.ts';
import { openDocument } from './service.ts';
import { DocumentSession } from './session.ts';
import {
  FAST,
  SECOND_PRINCIPAL,
  adminPool,
  connectTestClient,
  countUpdates,
  fakeSocketSession,
  startLiveServer,
  textOf,
  typeParagraph,
  until,
  type LiveHarness,
  type TestClient,
} from './testing-live.ts';

/**
 * The document lifecycle against real Postgres and real sockets: load once, sync live,
 * flush batched, snapshot on cadence, evict when idle - and recover all of it on
 * reconnect, because the log is the source of truth and memory never is.
 */

describe.runIf(DB_TESTS_ENABLED)('the document lifecycle, against Postgres', () => {
  let verifyPool: Pool;

  beforeAll(async () => {
    await seedTenants();
    verifyPool = adminPool();
  });

  afterAll(async () => {
    await verifyPool.end();
  });

  beforeEach(async () => {
    await clearContent();
  });

  const harnesses: LiveHarness[] = [];
  const clients: TestClient[] = [];

  function track(harness: LiveHarness): LiveHarness {
    harnesses.push(harness);
    return harness;
  }

  function open(url: string, itemId: string, token = 'as-first-principal'): TestClient {
    const client = connectTestClient(url, itemId, token);
    clients.push(client);
    return client;
  }

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.close();
    }
    await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  });

  it('converges two live clients through the resident document', async () => {
    const harness = track(await startLiveServer(TENANTS.alpha));
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
    const harness = track(await startLiveServer(TENANTS.alpha));
    const alice = open(harness.url, TENANTS.alpha.itemId);
    await alice.ready;

    typeParagraph(alice.doc, 'One.');
    typeParagraph(alice.doc, 'Two.');
    typeParagraph(alice.doc, 'Three.');

    await until(async () => (await countUpdates(verifyPool, TENANTS.alpha)) > 0, 'the flush to land');

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
    const harness = track(await startLiveServer(TENANTS.alpha));
    const first = open(harness.url, TENANTS.alpha.itemId, 'as-first-principal');
    const second = open(harness.url, TENANTS.alpha.itemId, 'as-second-principal');
    await Promise.all([first.ready, second.ready]);

    typeParagraph(first.doc, 'Signed by the first.');
    await until(async () => (await countUpdates(verifyPool, TENANTS.alpha)) >= 1, 'the first flush');
    typeParagraph(second.doc, 'Signed by the second.');
    await until(async () => (await countUpdates(verifyPool, TENANTS.alpha)) >= 2, 'the second flush');

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
    const harness = track(await startLiveServer(TENANTS.alpha));
    const alice = open(harness.url, TENANTS.alpha.itemId);
    await alice.ready;

    typeParagraph(alice.doc, 'Written before the crash.');
    await until(async () => (await countUpdates(verifyPool, TENANTS.alpha)) > 0, 'the flush to land');
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
    const harness = track(await startLiveServer(TENANTS.alpha));
    const alice = open(harness.url, TENANTS.alpha.itemId);
    await alice.ready;

    for (let index = 0; index < 6; index += 1) {
      typeParagraph(alice.doc, `Paragraph ${String(index)}.`);
    }
    await until(async () => (await countUpdates(verifyPool, TENANTS.alpha)) >= 6, 'the flush to land');
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
    const harness = track(await startLiveServer(TENANTS.alpha, { maxDocs: 0 }));

    const joined = await harness.registry.join(fakeSocketSession(TENANTS.alpha));

    expect(joined).toMatchObject({ ok: false, closeCode: 4413 });
  });

  it('refuses a document another instance owns, instead of serving it twice', async () => {
    const harness = track(await startLiveServer(TENANTS.alpha));
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
    const harness = track(await startLiveServer(TENANTS.alpha, { snapshotEvery: 100 }));
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
    await until(
      async () => (await countUpdates(verifyPool, TENANTS.alpha)) >= total,
      'every update to land',
      10_000,
    );
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

  it('broadcasts presence between clients and never writes a byte of it to the log', async () => {
    const harness = track(await startLiveServer(TENANTS.alpha));
    const alice = open(harness.url, TENANTS.alpha.itemId);
    const bella = open(harness.url, TENANTS.alpha.itemId, 'as-second-principal');
    await Promise.all([alice.ready, bella.ready]);

    alice.awareness.setLocalStateField('user', { name: 'Alice', color: 'var(--c)' });

    await until(() => {
      for (const state of bella.awareness.getStates().values()) {
        if ((state as { user?: { name?: string } }).user?.name === 'Alice') {
          return true;
        }
      }
      return false;
    }, "Alice's presence to reach Bella");

    // Presence is a fact about now: whatever moved over the wire, the durable log holds
    // nothing - awareness is never persisted, and an idle drain must not change that.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await countUpdates(verifyPool, TENANTS.alpha)).toBe(0);
  });

  it('drops a departed client from everyone else’s roster', async () => {
    const harness = track(await startLiveServer(TENANTS.alpha));
    const alice = open(harness.url, TENANTS.alpha.itemId);
    const bella = open(harness.url, TENANTS.alpha.itemId, 'as-second-principal');
    await Promise.all([alice.ready, bella.ready]);

    alice.awareness.setLocalStateField('user', { name: 'Alice', color: 'var(--c)' });
    const aliceId = alice.doc.clientID;
    await until(() => bella.awareness.getStates().has(aliceId), "Alice's presence to arrive");

    alice.close();

    await until(
      () => !bella.awareness.getStates().has(aliceId),
      "Alice's departure to reach Bella",
    );
  });

  it('flushes what is pending when the server shuts down, not never', async () => {
    const harness = track(await startLiveServer(TENANTS.alpha, { flushMs: 60_000 }));
    const alice = open(harness.url, TENANTS.alpha.itemId);
    await alice.ready;

    typeParagraph(alice.doc, 'Typed moments before the rollout.');
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Nothing has flushed - the window is a minute - so the shutdown drain is the only
    // thing standing between this edit and the crash-loss window.
    expect(await countUpdates(verifyPool, TENANTS.alpha)).toBe(0);
    await harness.close();

    expect(await countUpdates(verifyPool, TENANTS.alpha)).toBeGreaterThan(0);
  });

});
