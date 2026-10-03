import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { updatesAfter } from '../../db/documents.ts';
import { withTenantScope } from '../../db/tenant-scope.ts';
import { strategyFor } from '../../documents/body-kinds.ts';
import { LIMITS, rejection } from '../../documents/limits.ts';
import { CATCH_UP_LIMIT, applyUpdate, openDocument } from '../../documents/service.ts';
import { establish, type RouteDependencies } from '../context.ts';
import { decodeBase64, parseSeq } from '../params.ts';
import { problem } from '../replies.ts';

/** The update log over plain HTTP: catch up from a sequence, and append one update. */
export function registerUpdateRoutes(app: FastifyInstance, deps: RouteDependencies): void {
  const { rateWindow, newDocId } = deps;

  app.get('/documents/:itemId/updates', async (request: FastifyRequest, reply: FastifyReply) => {
    const context = await establish(request, reply, deps);
    if (context === null) {
      return reply;
    }

    const { after } = request.query as { after?: string };
    const afterSeq = parseSeq(after);
    if (afterSeq === null) {
      return problem(reply, 400, 'invalid_cursor', "'after' must be a non-negative integer.");
    }

    return await withTenantScope(deps.pool, context.scope, async (sql) => {
      const doc = await openDocument(
        sql,
        context.scope.tenantId,
        context.itemId,
        context.workspaceId,
        newDocId,
      );

      if (doc === null) {
        return problem(reply, 404, 'document_not_found', 'No document body is visible.');
      }

      const rows = await updatesAfter(
        sql,
        context.scope.tenantId,
        doc.doc_id,
        afterSeq,
        CATCH_UP_LIMIT,
      );

      return reply.send({
        docId: doc.doc_id,
        headSeq: doc.head_seq,
        schemaVersion: doc.schema_version,
        // Base64 rather than a binary body, because a catch-up returns many updates and a
        // multipart response would be a bespoke framing for both sides to get wrong.
        updates: rows.map((row) => ({
          seq: row.seq,
          clientId: row.client_id,
          update: Buffer.from(row.update_bytes).toString('base64'),
        })),
        // A full page means there is probably more; the client asks again from the last
        // sequence rather than assuming it has caught up.
        hasMore: rows.length === CATCH_UP_LIMIT,
      });
    });
  });

  app.post('/documents/:itemId/updates', async (request: FastifyRequest, reply: FastifyReply) => {
    const context = await establish(request, reply, deps);
    if (context === null) {
      return reply;
    }

    if (!context.canWrite) {
      // The permission gap the internal surface closed: reading an item never implied
      // writing its body, and now the answer that says so is enforced where the write lands.
      const refusal = rejection('read_only', 'You may read this document but not change it.');
      return problem(reply, refusal.status, refusal.code, refusal.detail);
    }

    const body = request.body as { update?: unknown; clientId?: unknown } | undefined;
    if (typeof body?.update !== 'string' || typeof body.clientId !== 'string') {
      return problem(
        reply,
        400,
        'invalid_body',
        'Expected { update: base64 string, clientId: string }.',
      );
    }

    // Applied before any database work: backpressure that costs a round trip is not much
    // backpressure.
    if (rateWindow.exceeded(context.scope.principalId, context.itemId)) {
      const refusal = rejection(
        'rate_limited',
        `At most ${String(LIMITS.updatesPerWindow)} updates per document per minute.`,
      );
      return problem(reply, refusal.status, refusal.code, refusal.detail);
    }

    const updateBytes = decodeBase64(body.update);
    if (updateBytes === null) {
      return problem(reply, 400, 'invalid_body', "'update' is not valid base64.");
    }

    return await withTenantScope(deps.pool, context.scope, async (sql) => {
      const doc = await openDocument(
        sql,
        context.scope.tenantId,
        context.itemId,
        context.workspaceId,
        newDocId,
      );

      if (doc === null) {
        return problem(reply, 404, 'document_not_found', 'No document body is visible.');
      }

      const applied = await applyUpdate(sql, {
        tenantId: context.scope.tenantId,
        doc,
        updateBytes,
        actorId: context.scope.principalId,
        clientId: body.clientId as string,
        // Publish on every REST write, not on the resident cadence. A socket session snapshots
        // when the last editor detaches - "exactly when they are owed" - because the snapshot is
        // what publishes a document's searchable text and its link edges. A stateless request has
        // no session, no idle clock and no eviction, so the moment its update lands is the only
        // moment it can ever publish: with the cadence applied here, a body written once through
        // this path (nixctl note write, an import) stayed invisible to search and backlinks until
        // someone happened to open it in the editor. Found live, 2026-08-21, importing 10k notes.
        snapshotEvery: 1,
        strategy: strategyFor(context.bodyKind),
      });

      if (!applied.ok) {
        return problem(reply, applied.error.status, applied.error.code, applied.error.detail);
      }

      return reply.code(202).send({
        docId: doc.doc_id,
        seq: applied.value.seq.toString(),
        snapshotWritten: applied.value.snapshotWritten,
      });
    });
  });
}
