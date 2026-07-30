import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DB_TESTS_ENABLED, TENANTS, clearContent, seedTenants } from '../db/testing.ts';
import {
  adminPool,
  connectTestClient,
  countUpdates,
  placeElement,
  startLiveServer,
  until,
  type LiveHarness,
  type TestClient,
} from './testing-live.ts';

/**
 * A canvas body, end to end: the same log, the same transport, the same lifecycle - only
 * the validation and the snapshot materialisation dispatch differently. Nothing in this
 * suite touches a canvas-specific server surface, because there is none to touch.
 */

describe.runIf(DB_TESTS_ENABLED)('a canvas body through the live server', () => {
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

  function open(url: string): TestClient {
    const client = connectTestClient(url, TENANTS.alpha.itemId, 'as-canvas-author');
    clients.push(client);
    return client;
  }

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.close();
    }
    await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  });

  it('converges two canvas editors on one scene', async () => {
    const harness = track(await startLiveServer(TENANTS.alpha));
    const drawer = open(harness.url);
    const partner = open(harness.url);
    await Promise.all([drawer.ready, partner.ready]);

    placeElement(drawer.doc, 'rect-1');
    placeElement(partner.doc, 'rect-2', { x: 100 });

    await until(
      () =>
        partner.doc.getMap('elements').has('rect-1') &&
        drawer.doc.getMap('elements').has('rect-2'),
      'both scenes to converge',
    );
  });

  it('tells the client which body kind it opened', async () => {
    const harness = track(await startLiveServer(TENANTS.alpha));
    const drawer = open(harness.url);

    const ready = (await drawer.ready) as { docId: string; mode: string; bodyKind?: string };

    expect(ready.bodyKind).toBe('canvas');
  });

  it('refuses a scene element without its reconciliation contract, keeping the socket', async () => {
    const harness = track(await startLiveServer(TENANTS.alpha));
    const drawer = open(harness.url);
    await drawer.ready;

    drawer.doc.getMap('elements').set('rogue', { type: 'rectangle' });

    await until(
      () => drawer.notices.some((notice) => notice.code === 'document_does_not_parse'),
      'the refusal notice',
    );
    expect(await countUpdates(verifyPool, TENANTS.alpha)).toBe(0);
  });

  it('snapshots a canvas as its scene and the words written on it', async () => {
    const harness = track(await startLiveServer(TENANTS.alpha, { snapshotEvery: 2 }));
    const drawer = open(harness.url);
    await drawer.ready;

    placeElement(drawer.doc, 'shape-1');
    placeElement(drawer.doc, 'title', { type: 'text', text: 'Quarterly plan' });
    placeElement(drawer.doc, 'shape-2', { x: 50 });

    await until(async () => {
      const { rows } = await verifyPool.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM content_snapshot s JOIN content_doc d USING (doc_id)
         WHERE d.tenant_id = $1 AND d.item_id = $2`,
        [TENANTS.alpha.tenantId, TENANTS.alpha.itemId],
      );
      return Number(rows[0]?.count ?? '0') > 0;
    }, 'a snapshot to land');

    const { rows } = await verifyPool.query<{ body: unknown; plaintext: string }>(
      `SELECT s.prosemirror_json AS body, s.plaintext
       FROM content_snapshot s JOIN content_doc d USING (doc_id)
       WHERE d.tenant_id = $1 AND d.item_id = $2
       ORDER BY s.seq DESC LIMIT 1`,
      [TENANTS.alpha.tenantId, TENANTS.alpha.itemId],
    );

    // The materialised column holds the scene for a canvas - named for prose, holding
    // whatever the body kind materialises - and the plaintext is what search can say
    // about a drawing: the words on it.
    expect(rows[0]?.body).toMatchObject({
      elements: { 'shape-1': { id: 'shape-1' }, title: { text: 'Quarterly plan' } },
    });
    expect(rows[0]?.plaintext).toContain('Quarterly plan');
  });
});
