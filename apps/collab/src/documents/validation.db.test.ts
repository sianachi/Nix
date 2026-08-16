import { SCHEMA_VERSION } from '@nix/editor-schema';
import type { Pool } from 'pg';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DB_TESTS_ENABLED, TENANTS, clearContent, collabPool, seedTenants } from '../db/testing.ts';
import { withTenantScope } from '../db/tenant-scope.ts';
import { LIMITS, RateWindow } from './limits.ts';
import { noteStrategy } from './body-kinds.ts';
import { openDocument } from './service.ts';
import { DocumentSession, judgeCandidate } from './session.ts';
import {
  adminPool,
  connectTestClient,
  countUpdates,
  fakeSocketSession,
  startLiveServer,
  textOf,
  typeParagraph,
  until,
  updateFrame,
  FAST,
  type LiveHarness,
  type TestClient,
} from './testing-live.ts';

/**
 * Section 17's validation table, row by row, on the socket path - reusing MVP-1's rules
 * rather than restating them. The rows that say "reject, log, do not disconnect" are
 * asserted from both halves: the notice arrives, and the socket survives.
 */

/** An update whose merged outcome no schema build accepts. */
function unparsableUpdate(): Uint8Array {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('default');
  fragment.insert(0, [new Y.XmlElement('no-such-node-kind')]);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

/** A well-formed paragraph update, from a fresh document. */
function paragraphUpdate(text: string): Uint8Array {
  const doc = new Y.Doc();
  typeParagraph(doc, text);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

describe.runIf(DB_TESTS_ENABLED)('update validation on the socket path', () => {
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

  function open(url: string, token = 'as-first-principal', schemaVersion?: number): TestClient {
    const client = connectTestClient(url, TENANTS.alpha.itemId, token, schemaVersion);
    clients.push(client);
    return client;
  }

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.close();
    }
    await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  });

  it('rejects a malformed CRDT update with a notice, and does not disconnect', async () => {
    const harness = track(await startLiveServer(TENANTS.alpha));
    const client = open(harness.url);
    await client.ready;

    client.sendRaw(updateFrame(new Uint8Array([0xff, 0xfe, 0xfd, 0x00, 0x01])));

    await until(
      () => client.notices.some((notice) => notice.code === 'update_unreadable'),
      'the notice',
    );
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    expect(await countUpdates(verifyPool, TENANTS.alpha)).toBe(0);
  });

  it('rejects an update over the byte ceiling, names the size, and does not disconnect', async () => {
    const harness = track(await startLiveServer(TENANTS.alpha));
    const client = open(harness.url);
    await client.ready;

    client.sendRaw(updateFrame(new Uint8Array(LIMITS.updateBytes + 1)));

    await until(
      () => client.notices.some((notice) => notice.code === 'update_too_large'),
      'the notice',
    );
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    expect(await countUpdates(verifyPool, TENANTS.alpha)).toBe(0);
  });

  it('refuses the connection of a client below the document schema pin, with the upgrade code', async () => {
    const harness = track(await startLiveServer(TENANTS.alpha));
    // A first client creates the document at the current pin.
    const current = open(harness.url);
    await current.ready;

    const stale = open(harness.url, 'as-first-principal', SCHEMA_VERSION - 1);
    const code = await new Promise<number>((resolve) => {
      stale.socket.on('close', resolve);
    });

    expect(code).toBe(4409);
  });

  it('rejects an update whose outcome the schema refuses, and forces a resync', async () => {
    const harness = track(await startLiveServer(TENANTS.alpha));
    const writer = open(harness.url);
    const witness = open(harness.url);
    await Promise.all([writer.ready, witness.ready]);
    const framesBefore = writer.syncFramesReceived();

    writer.sendRaw(updateFrame(unparsableUpdate()));

    await until(
      () => writer.notices.some((notice) => notice.code === 'document_does_not_parse'),
      'the notice',
    );
    // The refusal forces a resync: a fresh sync step 1 follows so the client reconciles
    // against the document the server kept, instead of silently editing a divergent one.
    await until(() => writer.syncFramesReceived() > framesBefore, 'the resync frame');
    expect(writer.socket.readyState).toBe(WebSocket.OPEN);

    // And the resident document never absorbed it: a witness's honest edit flushes to
    // the log, the refused one does not, and neither doc carries the refused node.
    typeParagraph(witness.doc, 'Still speaking prose.');
    await until(
      async () => (await countUpdates(verifyPool, TENANTS.alpha)) > 0,
      'the witness flush',
    );
    expect(textOf(witness.doc)).not.toContain('no-such-node-kind');
    expect(textOf(writer.doc)).not.toContain('no-such-node-kind');
  });

  it('mends a document a client emptied, instead of stranding the client on a refusal', async () => {
    // The failure this closes, observed in a dev log: the Yjs undo manager unwinds below the
    // schema's `block+` floor, which ProseMirror editing cannot do, and the emptying update
    // reaches the server alone. Refusing it leaves the client holding a document every later
    // update is refused against, for the same reason, with no edit that gets it out.
    const harness = track(await startLiveServer(TENANTS.alpha));
    const writer = open(harness.url);
    const witness = open(harness.url);
    await Promise.all([writer.ready, witness.ready]);

    typeParagraph(writer.doc, 'Something worth keeping.');
    await until(async () => (await countUpdates(verifyPool, TENANTS.alpha)) > 0, 'the first flush');

    // Counted from here, not from zero: opening a brand-new document that nobody has written to
    // yet legitimately draws a refusal, because an empty resident is not a document that fell
    // through its floor - it is one that was never over it. That is the behaviour this mend is
    // deliberately gated to leave alone, so the assertion below is about new refusals only.
    const refusalsBefore = writer.notices.filter(
      (notice) => notice.code === 'document_does_not_parse',
    ).length;

    // Straight at the shared document, below the editor: this is the seam under test, and what
    // produced it upstream is the client guard's business rather than the server's.
    const fragment = writer.doc.getXmlFragment('default');
    writer.doc.transact(() => {
      fragment.delete(0, fragment.length);
    });

    // No refusal, and the floor comes back on the writer's own document - which is the half a
    // broadcast that skips the origin would miss, and the half that decides whether the client
    // can go on editing.
    await until(() => writer.doc.getXmlFragment('default').length > 0, 'the mended floor');
    expect(
      writer.notices.filter((notice) => notice.code === 'document_does_not_parse').length,
    ).toBe(refusalsBefore);
    expect(noteStrategy.measure(writer.doc)).not.toBeNull();

    // Everyone else sees the same document, and it is the mended one rather than the empty one.
    await until(() => witness.doc.getXmlFragment('default').length > 0, 'the witness catching up');
    expect(textOf(witness.doc)).not.toContain('Something worth keeping.');
  });

  it('tells a reader their edits are refused, and keeps their socket', async () => {
    const harness = track(await startLiveServer(TENANTS.alpha));
    const reader = open(harness.url, 'as-reader');
    const ready = await reader.ready;
    expect(ready.mode).toBe('read');

    reader.sendRaw(updateFrame(paragraphUpdate('A reader trying to write.')));

    await until(() => reader.notices.some((notice) => notice.code === 'read_only'), 'the notice');
    expect(reader.socket.readyState).toBe(WebSocket.OPEN);
    expect(await countUpdates(verifyPool, TENANTS.alpha)).toBe(0);
  });

  it('applies backpressure past the rate window, then closes only for sustained abuse', async () => {
    const pool = collabPool();
    try {
      let clock = 1_000_000;
      const now = (): number => clock;
      const rateWindow = new RateWindow(now);

      const scope = { tenantId: TENANTS.alpha.tenantId, principalId: TENANTS.alpha.principalId };
      const docRow = await withTenantScope(pool, scope, (sql) =>
        openDocument(
          sql,
          scope.tenantId,
          TENANTS.alpha.itemId,
          TENANTS.alpha.workspaceId,
          () => TENANTS.alpha.docId,
        ),
      );
      if (docRow === null) {
        throw new Error('The seeded item has no document body.');
      }

      const session = await DocumentSession.load(TENANTS.alpha.itemId, docRow, scope, {
        pool,
        config: { ...FAST, flushMs: 3_600_000 },
        rateWindow,
        now,
      });
      const socket = fakeSocketSession(TENANTS.alpha);
      session.attach(socket);

      const frame = updateFrame(paragraphUpdate('Again and again.'));
      const noticesOf = (code: string): number =>
        socket.sent.filter((bytes) => Buffer.from(bytes).includes(Buffer.from(code))).length;

      // Fill the window, then one more: backpressure, not a close.
      for (let sent = 0; sent <= LIMITS.updatesPerWindow; sent += 1) {
        session.handleMessage(socket, frame);
      }
      expect(noticesOf('rate_limited')).toBeGreaterThan(0);
      expect(socket.closedWith).toEqual([]);

      // The same abuse across two more windows is a broken client, and the socket goes.
      for (let window = 1; window <= 2; window += 1) {
        clock += LIMITS.windowMs;
        for (let sent = 0; sent <= LIMITS.updatesPerWindow; sent += 1) {
          session.handleMessage(socket, frame);
        }
      }

      expect(socket.closedWith).toContainEqual(expect.objectContaining({ code: 4429 }) as unknown);

      session.detach(socket);
      await session.drain();
    } finally {
      await pool.end();
    }
  }, 30_000);

  it('lets a delete through on a document over its ceiling, and refuses growth', () => {
    const resident = new Y.Doc();
    for (let index = 0; index < 5; index += 1) {
      typeParagraph(resident, `Paragraph ${String(index)}.`);
    }

    const before = noteStrategy.measure(resident);
    if (before === null) {
      throw new Error('The prose fixture must parse.');
    }
    // A ceiling the resident document already exceeds, which is the only state where the
    // growth rule and a plain ceiling check disagree.
    const tinyCeiling = { nodes: before.nodes - 4, bytes: LIMITS.documentBytes };

    // Growth on an over-ceiling document is refused...
    const grower = new Y.Doc();
    Y.applyUpdate(grower, Y.encodeStateAsUpdate(resident));
    typeParagraph(grower, 'One more.');
    const growth = Y.encodeStateAsUpdate(grower, Y.encodeStateVector(resident));
    const refused = judgeCandidate(resident, growth, {
      strategy: noteStrategy,
      ceilings: tinyCeiling,
    });
    expect(refused).toMatchObject({ ok: false, refusal: { code: 'document_too_many_nodes' } });

    // ...and a delete that leaves the document smaller - though still over the ceiling -
    // is exactly what must go through, because it is the path back under it.
    const shrinker = new Y.Doc();
    Y.applyUpdate(shrinker, Y.encodeStateAsUpdate(resident));
    shrinker.getXmlFragment('default').delete(0, 1);
    const shrinkage = Y.encodeStateAsUpdate(shrinker, Y.encodeStateVector(resident));
    expect(
      judgeCandidate(resident, shrinkage, { strategy: noteStrategy, ceilings: tinyCeiling }),
    ).toMatchObject({ ok: true });

    resident.destroy();
    grower.destroy();
    shrinker.destroy();
  });
});
