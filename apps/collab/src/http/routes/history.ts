import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  deleteNamedVersion,
  listNamedVersions,
  listRevisions,
  nameVersion,
  stateAt,
} from '../../db/history.ts';
import { withTenantScope } from '../../db/tenant-scope.ts';
import { strategyFor } from '../../documents/body-kinds.ts';
import { rejection } from '../../documents/limits.ts';
import { openDocument, restoreDocument } from '../../documents/service.ts';
import { establish, type RouteDependencies } from '../context.ts';
import { parseLimit, parseOptionalSeq, parseSeqBody, parseSeqParam } from '../params.ts';
import { problem } from '../replies.ts';

/**
 * Version history: revisions, a state at a sequence, restoring to it, and the names pinned
 * to a revision. Six routes, one authorization path - every handler below starts with the
 * same `establish` every other document route uses, so a permission change takes effect
 * here exactly as promptly as it does on the update log itself.
 */
export function registerHistoryRoutes(app: FastifyInstance, deps: RouteDependencies): void {
  const { newDocId } = deps;

  app.get('/documents/:itemId/history', async (request: FastifyRequest, reply: FastifyReply) => {
    const context = await establish(request, reply, deps);
    if (context === null) {
      return reply;
    }

    const query = request.query as { before?: string; limit?: string };
    const before = parseOptionalSeq(query.before);
    if (before === 'invalid') {
      return problem(reply, 400, 'history_seq_invalid', "'before' must be a non-negative integer.");
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

      const page = await listRevisions(sql, context.scope.tenantId, doc.doc_id, {
        ...(before === undefined ? {} : { before }),
        limit: parseLimit(query.limit),
      });

      return reply.send({
        revisions: page.revisions,
        hasMore: page.hasMore,
        headSeq: doc.head_seq,
      });
    });
  });

  app.get(
    '/documents/:itemId/history/:seq',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const context = await establish(request, reply, deps);
      if (context === null) {
        return reply;
      }

      const { seq: rawSeq } = request.params as { itemId: string; seq: string };
      const seq = parseSeqParam(rawSeq);
      if (seq === null) {
        return problem(reply, 400, 'history_seq_invalid', "'seq' must be a non-negative integer.");
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

        const state = await stateAt(sql, context.scope.tenantId, doc.doc_id, seq);
        if (state === null) {
          return problem(
            reply,
            404,
            'history_state_unavailable',
            'That state cannot be reconstructed: it is beyond the head, or its base has been pruned.',
          );
        }

        // The same conversion the snapshot writer uses (`writeSnapshotNow`), so a client that
        // renders `document` from a snapshot and `document` from this route never has to
        // reconcile two different ideas of what a document looks like as JSON.
        const materialized = strategyFor(context.bodyKind).materialize(state);

        return reply.send({
          seq,
          document: materialized.json,
          plaintext: materialized.plaintext,
          headSeq: doc.head_seq,
        });
      });
    },
  );

  app.post(
    '/documents/:itemId/history/:seq/restore',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const context = await establish(request, reply, deps);
      if (context === null) {
        return reply;
      }

      if (!context.canWrite) {
        const refusal = rejection('read_only', 'You may read this document but not change it.');
        return problem(reply, refusal.status, refusal.code, refusal.detail);
      }

      const { seq: rawSeq } = request.params as { itemId: string; seq: string };
      const seq = parseSeqParam(rawSeq);
      if (seq === null) {
        return problem(reply, 400, 'history_seq_invalid', "'seq' must be a non-negative integer.");
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

        const restored = await restoreDocument(sql, {
          tenantId: context.scope.tenantId,
          doc,
          seq,
          actorId: context.scope.principalId,
          // A restore is one client-visible write; a fabricated identifier, not the
          // requester's own client id, because a restore has no editor session behind it.
          clientId: `restore:${randomUUID()}`,
          strategy: strategyFor(context.bodyKind),
        });

        if (!restored.ok) {
          return problem(reply, restored.error.status, restored.error.code, restored.error.detail);
        }

        return reply.send({ headSeq: restored.value.seq.toString() });
      });
    },
  );

  app.get('/documents/:itemId/versions', async (request: FastifyRequest, reply: FastifyReply) => {
    const context = await establish(request, reply, deps);
    if (context === null) {
      return reply;
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

      const versions = await listNamedVersions(sql, context.scope.tenantId, doc.doc_id);
      return reply.send({ versions });
    });
  });

  app.post('/documents/:itemId/versions', async (request: FastifyRequest, reply: FastifyReply) => {
    const context = await establish(request, reply, deps);
    if (context === null) {
      return reply;
    }

    if (!context.canWrite) {
      const refusal = rejection('read_only', 'You may read this document but not change it.');
      return problem(reply, refusal.status, refusal.code, refusal.detail);
    }

    const body = request.body as { seq?: unknown; name?: unknown } | undefined;
    const seq = parseSeqBody(body?.seq);
    if (seq === null) {
      return problem(reply, 400, 'history_seq_invalid', "'seq' must be a non-negative integer.");
    }

    const name = typeof body?.name === 'string' ? body.name.trim() : null;
    if (name === null || name.length < 1 || name.length > 120) {
      return problem(reply, 400, 'version_name_invalid', "'name' must be 1 to 120 characters.");
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

      try {
        const version = await nameVersion(
          sql,
          context.scope.tenantId,
          doc.doc_id,
          seq,
          name,
          context.scope.principalId,
        );
        return await reply.code(201).send(version);
      } catch {
        // nameVersion's only throw is "this state cannot be reconstructed" - beyond the head,
        // or its base pruned - which is exactly what the read routes call
        // `history_state_unavailable` for.
        return problem(
          reply,
          404,
          'history_state_unavailable',
          'That state cannot be reconstructed: it is beyond the head, or its base has been pruned.',
        );
      }
    });
  });

  app.delete(
    '/documents/:itemId/versions/:seq',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const context = await establish(request, reply, deps);
      if (context === null) {
        return reply;
      }

      if (!context.canWrite) {
        const refusal = rejection('read_only', 'You may read this document but not change it.');
        return problem(reply, refusal.status, refusal.code, refusal.detail);
      }

      const { seq: rawSeq } = request.params as { itemId: string; seq: string };
      const seq = parseSeqParam(rawSeq);
      if (seq === null) {
        return problem(reply, 400, 'history_seq_invalid', "'seq' must be a non-negative integer.");
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

        const removed = await deleteNamedVersion(sql, context.scope.tenantId, doc.doc_id, seq);
        if (!removed) {
          return problem(reply, 404, 'version_not_found', 'No such named version.');
        }

        return await reply.code(204).send();
      });
    },
  );
}
