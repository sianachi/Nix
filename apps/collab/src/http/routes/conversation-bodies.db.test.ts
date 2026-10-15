import Fastify from 'fastify';
import { nixSchema } from '@nix/editor-schema';
import type { Pool } from 'pg';
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import * as Y from 'yjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  DB_TESTS_ENABLED,
  TENANTS,
  clearContent,
  collabPool,
  seedTenants,
} from '../../db/testing.ts';
import { withTenantScope } from '../../db/tenant-scope.ts';
import { openDocument, applyUpdate, FRAGMENT_NAME } from '../../documents/service.ts';
import { registerConversationBodyRoutes, CONVERSATION_BODY_LIMIT } from './conversation-bodies.ts';

const tenant = TENANTS.alpha;
describe.skipIf(!DB_TESTS_ENABLED)('conversation body reads from the durable log', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = collabPool();
    await seedTenants();
  });
  beforeEach(clearContent);
  afterAll(async () => {
    await clearContent();
    await pool.end();
  });

  async function write(text: string) {
    const state = new Y.Doc();
    prosemirrorJSONToYXmlFragment(
      nixSchema,
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
      state.getXmlFragment(FRAGMENT_NAME),
    );
    try {
      await withTenantScope(pool, tenant, async (sql) => {
        const doc = await openDocument(
          sql,
          tenant.tenantId,
          tenant.itemId,
          tenant.workspaceId,
          () => tenant.docId,
        );
        if (doc === null) throw new Error('No document');
        const appended = await applyUpdate(sql, {
          tenantId: tenant.tenantId,
          doc,
          actorId: tenant.principalId,
          clientId: 'conversation-test',
          updateBytes: Y.encodeStateAsUpdate(state),
          snapshotEvery: 100,
        });
        expect(appended.ok).toBe(true);
      });
    } finally {
      state.destroy();
    }
  }

  async function read(itemId = tenant.itemId) {
    const app = Fastify();
    registerConversationBodyRoutes(app, {
      pool,
      internalSecret: 'secret',
      conversationBodyAuthorizer: {
        authorize: () => Promise.resolve({ ...tenant, bodyKind: 'note' }),
      },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/internal/conversations/${tenant.targetItemId}/body`,
        headers: { 'x-nix-internal-secret': 'secret' },
        payload: {
          tenantId: tenant.tenantId,
          principalId: tenant.principalId,
          workspaceId: tenant.workspaceId,
          itemId,
          requestId: tenant.docId,
        },
      });
      expect(response.statusCode).toBe(200);
      const result: unknown = response.json();
      return result;
    } finally {
      await app.close();
    }
  }

  it('replays actual prose from saved Yjs updates without requiring a snapshot', async () => {
    await write('The alpha workspace launch is scheduled for Friday.');
    expect(await read()).toEqual({
      text: 'The alpha workspace launch is scheduled for Friday.',
      truncated: false,
      unsupported: false,
    });
  });

  it('bounds prose and reports truncation', async () => {
    await write('x'.repeat(CONVERSATION_BODY_LIMIT + 100));
    expect(await read()).toEqual({
      text: 'x'.repeat(CONVERSATION_BODY_LIMIT),
      truncated: true,
      unsupported: false,
    });
  });
});
