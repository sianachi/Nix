import type { Pool } from 'pg';

import { withTenantScope } from '../db/tenant-scope.ts';
import { openDocument } from '../documents/service.ts';
import { CLOSE_CODES } from './protocol.ts';
import type { JoinResult, SessionHub, SocketSession } from './server.ts';

/**
 * The hub the socket endpoint ships with before documents are resident: it answers the
 * handshake - which document, which schema pin - and nothing after it.
 *
 * Sync and awareness arrive with the document lifecycle, which replaces this hub wholesale.
 * Keeping the handshake correct on its own is what lets the two land as separate goals: a
 * client refused here for a schema mismatch is refused for exactly the reason, and with
 * exactly the code, the full lifecycle will refuse it with.
 */
export function createHandshakeHub(deps: {
  pool: Pool;
  newDocId: () => string;
}): SessionHub {
  return {
    async join(session: SocketSession): Promise<JoinResult> {
      const { authorization } = session;

      const doc = await withTenantScope(
        deps.pool,
        { tenantId: authorization.tenantId, principalId: authorization.principalId },
        (sql) =>
          openDocument(
            sql,
            authorization.tenantId,
            session.itemId,
            authorization.workspaceId,
            deps.newDocId,
          ),
      );

      if (doc === null) {
        return {
          ok: false,
          closeCode: CLOSE_CODES.notFound,
          reason: 'No document body is visible.',
        };
      }

      if (session.clientSchemaVersion < doc.schema_version) {
        // The §17 rule: a client speaking an older schema than the document is pinned to is
        // refused at the connection, with a code that means "upgrade", before it can write
        // a node this document's other readers cannot open.
        return {
          ok: false,
          closeCode: CLOSE_CODES.schemaMismatch,
          reason: `This document is pinned to schema version ${String(doc.schema_version)}.`,
        };
      }

      return { ok: true, docId: doc.doc_id, schemaVersion: doc.schema_version };
    },

    handleMessage(): void {
      // No document is resident, so there is nothing correct to do with a sync frame yet.
    },

    leave(): void {
      // Nothing was joined beyond the handshake, so there is nothing to leave.
    },
  };
}
