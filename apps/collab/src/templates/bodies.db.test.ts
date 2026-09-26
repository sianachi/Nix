import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DB_TESTS_ENABLED, TENANTS, clearContent, collabPool, seedTenants } from '../db/testing.ts';
import { findDocByItem } from '../db/documents.ts';
import { appendUpdate } from '../db/documents.ts';
import { withTenantScope } from '../db/tenant-scope.ts';
import { strategyFor } from '../documents/body-kinds.ts';
import { loadDocument } from '../documents/service.ts';
import { copyBodies, writeArchiveBodies } from './bodies.ts';
import * as Y from 'yjs';

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

    const source = await withTenantScope(
      pool,
      { tenantId: tenant.tenantId, principalId: tenant.principalId },
      (sql) => findDocByItem(sql, tenant.tenantId, tenant.itemId),
    );
    if (source === null) throw new Error('The source body is missing.');

    await copyBodies(
      pool,
      authorization,
      [
        {
          sourceItemId: tenant.itemId,
          targetItemId: tenant.targetItemId,
          itemType: 'note',
          checkHead: true,
          expectedDocId: source.doc_id,
          expectedHeadSeq: Number(source.head_seq),
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

    const changed = new Y.Doc();
    changed.getText('body').insert(0, 'changed');
    try {
      await withTenantScope(
        pool,
        { tenantId: tenant.tenantId, principalId: tenant.principalId },
        (sql) =>
          appendUpdate(sql, {
            tenantId: tenant.tenantId,
            docId: source.doc_id,
            updateBytes: Y.encodeStateAsUpdate(changed),
            actorId: tenant.principalId,
            clientId: 'template-pin-test',
          }),
      );
    } finally {
      changed.destroy();
    }
    await expect(
      copyBodies(
        pool,
        authorization,
        [
          {
            sourceItemId: tenant.itemId,
            targetItemId: tenant.targetItemId,
            itemType: 'note',
            checkHead: true,
            expectedDocId: source.doc_id,
            expectedHeadSeq: Number(source.head_seq),
          },
        ],
        new Map([[tenant.itemId, tenant.targetItemId]]),
      ),
    ).rejects.toMatchObject({ code: 'templates.conflict' });
  });
});
