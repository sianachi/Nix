import type { Pool } from 'pg';
import * as Y from 'yjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  DB_TESTS_ENABLED,
  TENANTS,
  clearContent,
  collabPool,
  seedTenants,
  type TestTenant,
} from '../db/testing.ts';
import { withTenantScope } from '../db/tenant-scope.ts';
import { canvasStrategy, sheetStrategy } from '../documents/body-kinds.ts';
import { applyUpdate, openDocument } from '../documents/service.ts';
import type { CoreItem } from '../core/client.ts';
import { streamBundles } from './assemble.ts';

/**
 * What an exported bundle carries for each body kind.
 *
 * This needs a database because a body only exists as a replay of the update log - there is no way
 * to ask what an export would carry without writing one and reading it back, which is the whole
 * reason the gap this suite pins went unnoticed: every unit test in this folder stops at the
 * manifest, above the layer where the body is read.
 */
describe.skipIf(!DB_TESTS_ENABLED)('the body an export carries', () => {
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

  /** The item as Core would report it, with the type that chooses how its body is read. */
  function itemOf(tenant: TestTenant, type: string): CoreItem {
    return {
      id: tenant.itemId,
      parentId: null,
      workspaceId: tenant.workspaceId,
      type,
      title: `a ${type}`,
      seq: '1000',
      lifecycleState: 'active',
      createdAt: '2026-08-13T00:00:00Z',
      updatedAt: '2026-08-13T00:00:00Z',
      properties: {},
      hasChildren: false,
    };
  }

  /**
   * Writes one update into the item's document and returns the bundle an export would produce.
   *
   * `write` receives the document before the update is captured, so each test states its body in
   * the same shape a client would send rather than through a fixture this file invents.
   */
  async function exportedBody(
    tenant: TestTenant,
    type: string,
    write: (state: Y.Doc) => void,
  ): Promise<unknown> {
    const state = new Y.Doc();
    Y.applyUpdate(state, Y.encodeStateAsUpdate(new Y.Doc()));

    write(state);
    const update = Y.encodeStateAsUpdate(state);
    state.destroy();

    const item = itemOf(tenant, type);

    return await withTenantScope(pool, scopeOf(tenant), async (sql) => {
      const doc = await openDocument(
        sql,
        tenant.tenantId,
        tenant.itemId,
        tenant.workspaceId,
        () => tenant.docId,
      );

      if (doc === null) {
        throw new Error('The document was not created.');
      }

      const applied = await applyUpdate(sql, {
        tenantId: tenant.tenantId,
        doc,
        updateBytes: update,
        actorId: tenant.principalId,
        clientId: 'export-test',
        snapshotEvery: 1,
        strategy: type === 'canvas' ? canvasStrategy : sheetStrategy,
      });

      if (!applied.ok) {
        throw new Error(`The update was refused: ${applied.error.detail}`);
      }

      for await (const bundle of streamBundles({
        sql,
        tenantId: tenant.tenantId,
        items: [item],
        metadata: { schemas: new Map(), views: new Map() },
      })) {
        return bundle.body;
      }

      throw new Error('No bundle was produced.');
    });
  }

  it('carries a canvas scene, which the lossless format claims and once did not do', async () => {
    const body = await exportedBody(TENANTS.alpha, 'canvas', (state) => {
      state.getMap('elements').set('rect-1', {
        id: 'rect-1',
        version: 1,
        versionNonce: 7,
        type: 'rectangle',
        x: 10,
        y: 20,
      });
    });

    // Not merely non-null: a canvas read through the prose branch also produced a body-shaped
    // answer once the null check was passed, so the assertion has to reach the scene itself.
    expect(body).toMatchObject({
      canvas: { elements: { 'rect-1': { id: 'rect-1', type: 'rectangle' } } },
    });
  });

  it('carries a sheet grid on its own arm rather than as prose', async () => {
    const body = await exportedBody(TENANTS.beta, 'spreadsheet', (state) => {
      state.getMap('cells').set('A1', { input: 'Hello' });
    });

    expect(body).toHaveProperty('sheet');
  });
});
