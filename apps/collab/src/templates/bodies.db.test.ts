import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DB_TESTS_ENABLED, TENANTS, clearContent, collabPool, seedTenants } from '../db/testing.ts';
import { findDocByItem } from '../db/documents.ts';
import { withTenantScope } from '../db/tenant-scope.ts';
import { strategyFor } from '../documents/body-kinds.ts';
import { loadDocument } from '../documents/service.ts';
import { copyBodies, writeArchiveBodies } from './bodies.ts';

describe.runIf(DB_TESTS_ENABLED)('bulk template bodies, against Postgres', () => {
  const pool = collabPool();
  const tenant = TENANTS.alpha;
  const authorization = {
    tenantId: tenant.tenantId,
    principalId: tenant.principalId,
    workspaceId: tenant.workspaceId,
    itemType: 'note',
    canWrite: true,
  } as const;

  beforeAll(seedTenants);
  beforeEach(clearContent);
  afterAll(async () => {
    await pool.end();
  });

  it('bulk-initializes an archive body and clones it through the batched source reader', async () => {
    await writeArchiveBodies(
      pool,
      authorization,
      [
        {
          sourceId: tenant.itemId,
          targetItemId: tenant.itemId,
          itemType: 'note',
          body: {
            schemaVersion: 2,
            prosemirror: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Bulk body.' }],
                },
              ],
            },
          },
        },
      ],
      new Map(),
    );

    await copyBodies(
      pool,
      authorization,
      [
        {
          sourceItemId: tenant.itemId,
          targetItemId: tenant.targetItemId,
          itemType: 'note',
        },
      ],
      new Map([[tenant.itemId, tenant.targetItemId]]),
    );

    const materialized = await withTenantScope(
      pool,
      { tenantId: tenant.tenantId, principalId: tenant.principalId },
      async (sql) => {
        const row = await findDocByItem(sql, tenant.tenantId, tenant.targetItemId);
        if (row === null) throw new Error('The copied target body is missing.');
        const state = await loadDocument(sql, tenant.tenantId, row);
        try {
          return strategyFor('note').materialize(state).json;
        } finally {
          state.destroy();
        }
      },
    );

    expect(materialized).toMatchObject({
      content: [{ content: [{ text: 'Bulk body.' }] }],
    });
  });
});
