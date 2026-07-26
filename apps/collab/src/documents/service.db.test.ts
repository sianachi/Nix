import { SCHEMA_VERSION, nixSchema } from '@nix/editor-schema';
import type { Pool } from 'pg';
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import * as Y from 'yjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { findDocByItem, updatesAfter } from '../db/documents.ts';
import {
  DB_TESTS_ENABLED,
  TENANTS,
  clearContent,
  collabPool,
  seedTenants,
  type TestTenant,
} from '../db/testing.ts';
import { withTenantScope } from '../db/tenant-scope.ts';
import { FRAGMENT_NAME, applyUpdate, loadDocument, openDocument } from './service.ts';

/**
 * The collaboration service against real Postgres.
 *
 * Two claims are being made here and neither can be checked without a database. The first is
 * that this service isolates tenants - it reaches the content tables directly, with its own
 * credentials, and the .NET interceptor that enforces the scope on the other side does not
 * exist in Node. The second is that concurrent edits converge, which is the whole reason the
 * log holds Yjs updates rather than document snapshots.
 *
 * Requires the development stack: `docker compose -f deploy/compose.dev.yml --profile core up
 * -d`, then `deploy/seed/seed.sh`, then the migrator.
 */
describe.skipIf(!DB_TESTS_ENABLED)('the collaboration service, against Postgres', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = collabPool();
    await seedTenants();
  });

  afterAll(async () => {
    await clearContent();
    await pool.end();
  });

  beforeEach(async () => {
    await clearContent();
  });

  function scopeOf(tenant: TestTenant) {
    return { tenantId: tenant.tenantId, principalId: tenant.principalId };
  }

  async function open(tenant: TestTenant) {
    return await withTenantScope(pool, scopeOf(tenant), async (sql) => {
      const doc = await openDocument(
        sql,
        tenant.tenantId,
        tenant.itemId,
        tenant.workspaceId,
        () => tenant.docId,
      );

      if (doc === null) throw new Error('The document was not created.');
      return doc;
    });
  }

  /**
   * One update that types `text` into an empty document.
   *
   * Built through the shared schema, so a block this build cannot express cannot be smuggled
   * into a fixture - which is the whole point of the schema living in its own package.
   */
  function updateTyping(text: string): Uint8Array {
    const doc = new Y.Doc();
    prosemirrorJSONToYXmlFragment(
      nixSchema,
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
      doc.getXmlFragment(FRAGMENT_NAME),
    );

    return Y.encodeStateAsUpdate(doc);
  }

  it('creates a document body on first use, once, whoever asks first', async () => {
    const first = await open(TENANTS.alpha);
    const second = await open(TENANTS.alpha);

    expect(second.doc_id).toBe(first.doc_id);
    expect(second.schema_version).toBe(SCHEMA_VERSION);
  });

  it('never shows one tenant the other tenant s document', async () => {
    await open(TENANTS.alpha);
    await open(TENANTS.beta);

    // Beta asking for Alpha's item. The row exists; the policies make it invisible.
    const seen = await withTenantScope(pool, scopeOf(TENANTS.beta), (sql) =>
      findDocByItem(sql, TENANTS.alpha.tenantId, TENANTS.alpha.itemId),
    );

    expect(seen).toBeNull();
  });

  it('never shows one tenant the other tenant s updates', async () => {
    const alpha = await open(TENANTS.alpha);

    await withTenantScope(pool, scopeOf(TENANTS.alpha), (sql) =>
      applyUpdate(sql, {
        tenantId: TENANTS.alpha.tenantId,
        doc: alpha,
        updateBytes: updateTyping('Alpha writes here'),
        actorId: TENANTS.alpha.principalId,
        clientId: 'alpha-client',
        snapshotEvery: 0,
      }),
    );

    // Beta knows Alpha's document identifier - the worst case, and the one the policies have
    // to survive, because an identifier is not a secret.
    const rows = await withTenantScope(pool, scopeOf(TENANTS.beta), (sql) =>
      updatesAfter(sql, TENANTS.alpha.tenantId, alpha.doc_id, 0n, 100),
    );

    expect(rows).toEqual([]);
  });

  it('allocates sequences without gaps or collisions across concurrent appends', async () => {
    const alpha = await open(TENANTS.alpha);

    const appends = Array.from({ length: 8 }, (_unused, index) =>
      withTenantScope(pool, scopeOf(TENANTS.alpha), (sql) =>
        applyUpdate(sql, {
          tenantId: TENANTS.alpha.tenantId,
          doc: alpha,
          updateBytes: updateTyping(`edit ${String(index)}`),
          actorId: TENANTS.alpha.principalId,
          clientId: `client-${String(index)}`,
          snapshotEvery: 0,
        }),
      ),
    );

    const results = await Promise.all(appends);
    const sequences = results
      .map((result) => (result.ok ? Number(result.value.seq) : -1))
      .sort((left, right) => left - right);

    // The database allocates them under a row lock, so eight concurrent appends produce
    // exactly 1..8. A number chosen in the service would collide the first time two people
    // typed at once, and the log would lose one of them.
    expect(sequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('converges two clients that edited without seeing each other', async () => {
    const alpha = await open(TENANTS.alpha);

    // Two documents that share no history: this is the offline case, and the reason the log
    // holds CRDT updates rather than document snapshots. Last-write-wins would lose one side.
    const left = new Y.Doc();
    const right = new Y.Doc();

    left.getXmlFragment(FRAGMENT_NAME);
    right.getXmlFragment(FRAGMENT_NAME);

    prosemirrorJSONToYXmlFragment(
      nixSchema,
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'left' }] }] },
      left.getXmlFragment(FRAGMENT_NAME),
    );
    prosemirrorJSONToYXmlFragment(
      nixSchema,
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'right' }] }] },
      right.getXmlFragment(FRAGMENT_NAME),
    );

    for (const [clientId, update] of [
      ['left', Y.encodeStateAsUpdate(left)],
      ['right', Y.encodeStateAsUpdate(right)],
    ] as const) {
      const result = await withTenantScope(pool, scopeOf(TENANTS.alpha), (sql) =>
        applyUpdate(sql, {
          tenantId: TENANTS.alpha.tenantId,
          doc: alpha,
          updateBytes: update,
          actorId: TENANTS.alpha.principalId,
          clientId,
          snapshotEvery: 0,
        }),
      );

      expect(result.ok).toBe(true);
    }

    const merged = await withTenantScope(pool, scopeOf(TENANTS.alpha), async (sql) => {
      const doc = await findDocByItem(sql, TENANTS.alpha.tenantId, TENANTS.alpha.itemId);
      if (doc === null) throw new Error('The document disappeared.');
      return await loadDocument(sql, TENANTS.alpha.tenantId, doc);
    });

    const text = merged.getXmlFragment(FRAGMENT_NAME).toJSON();

    // Both survive. Which order they appear in is the CRDT's decision and is deliberately
    // not asserted - what matters is that nothing was thrown away.
    expect(text).toContain('left');
    expect(text).toContain('right');
  });

  it('writes a snapshot on the cadence, and the snapshot is only an optimisation', async () => {
    const alpha = await open(TENANTS.alpha);

    for (let index = 0; index < 3; index += 1) {
      await withTenantScope(pool, scopeOf(TENANTS.alpha), (sql) =>
        applyUpdate(sql, {
          tenantId: TENANTS.alpha.tenantId,
          doc: alpha,
          updateBytes: updateTyping(`line ${String(index)}`),
          actorId: TENANTS.alpha.principalId,
          clientId: 'client',
          snapshotEvery: 2,
        }),
      );
    }

    const snapshots = await withTenantScope(pool, scopeOf(TENANTS.alpha), (sql) =>
      sql.query<{ seq: string }>(
        'SELECT seq FROM content_snapshot WHERE doc_id = $1 ORDER BY seq',
        [alpha.doc_id],
      ),
    );

    expect(snapshots.rows.map((row) => row.seq)).toEqual(['2']);
  });

  it('refuses an update that is not a Yjs payload at all', async () => {
    const alpha = await open(TENANTS.alpha);

    const result = await withTenantScope(pool, scopeOf(TENANTS.alpha), (sql) =>
      applyUpdate(sql, {
        tenantId: TENANTS.alpha.tenantId,
        doc: alpha,
        updateBytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
        actorId: TENANTS.alpha.principalId,
        clientId: 'client',
        snapshotEvery: 0,
      }),
    );

    expect(result.ok).toBe(false);

    // Refused means nothing was stored: the log is the source of truth and must not hold a
    // payload that cannot be replayed.
    const rows = await withTenantScope(pool, scopeOf(TENANTS.alpha), (sql) =>
      updatesAfter(sql, TENANTS.alpha.tenantId, alpha.doc_id, 0n, 10),
    );

    expect(rows).toEqual([]);
  });

  it('refuses an update larger than the column would accept', async () => {
    const alpha = await open(TENANTS.alpha);

    const result = await withTenantScope(pool, scopeOf(TENANTS.alpha), (sql) =>
      applyUpdate(sql, {
        tenantId: TENANTS.alpha.tenantId,
        doc: alpha,
        updateBytes: new Uint8Array(2 * 1024 * 1024),
        actorId: TENANTS.alpha.principalId,
        clientId: 'client',
        snapshotEvery: 0,
      }),
    );

    // The service's ceiling matches the CHECK on the column, so this is a 413 with a code a
    // client can act on rather than a constraint violation surfacing as a 500.
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.code).toBe('update_too_large');
    expect(result.ok ? null : result.error.status).toBe(413);
  });
});
