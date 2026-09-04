import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';

import { TEMPLATE_IMPORT_REQUEST_BYTES, exportFileName, writeArchive } from '@nix/export';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

import type { CoreClient } from '../core/client.ts';
import { STREAM_MEDIA_TYPE, writeBundleStream } from '../export/ndjson.ts';
import {
  prepareExport,
  readExportedAt,
  readScope,
  type PreparedExport,
} from '../export/prepare.ts';
import { withTenantScope } from '../db/tenant-scope.ts';
import { strategyFor } from '../documents/body-kinds.ts';
import { LIMITS, rejection } from '../documents/limits.ts';
import { RateWindow } from '../documents/limits.ts';
import { CATCH_UP_LIMIT, applyUpdate, describeSchema, openDocument } from '../documents/service.ts';
import { updatesAfter } from '../db/documents.ts';
import type { CollabMetrics } from '../metrics.ts';
import { importBodyProblem, type ImportBodyService } from '../imports/bodies.ts';
import { CoreImportError } from '../imports/core.ts';
import {
  TemplateImportBodyError,
  type TemplateImportBodyService,
} from '../template-imports/bodies.ts';
import { CoreTemplateImportError } from '../template-imports/core.ts';
import { TemplateBodyError } from '../templates/bodies.ts';
import { CoreTemplateError } from '../templates/core.ts';
import {
  parseApplicationRequest,
  parseBeginDraftRequest,
  parseCaptureRequest,
  parseDraftItemPatch,
  parseDraftMetadataPatch,
  parseImportedTemplate,
  parseManagedFinalizeRequest,
  TemplateHttpContractError,
} from '../templates/http-contracts.ts';
import type { TemplateService } from '../templates/service.ts';
import { createHandshakeHub } from '../ws/handshake-hub.ts';
import { CLOSE_CODES } from '../ws/protocol.ts';
import { attachWebSocketServer, type SessionHub } from '../ws/server.ts';
import type { SessionAuthenticator } from '../ws/session-auth.ts';

export interface ServerDependencies {
  readonly pool: Pool;

  /**
   * The one authenticate-and-authorize path, shared by the HTTP endpoints and the socket
   * handshake so there is a single cache and a single behaviour to reason about.
   */
  readonly sessions: SessionAuthenticator;

  /**
   * Core's public surface, for the export routes.
   *
   * An export needs an item's title, its children and their schemas - none of which live in the
   * content tables this service owns. It reads them as the caller, with the caller's token, so an
   * export can never contain more than the person asking for it may see.
   */
  readonly core: CoreClient;

  /**
   * The shared secret that says *which service* is calling the internal surface.
   *
   * Paired with the caller's forwarded token, which says *on whose behalf* - the same two facts
   * this service presents to Core, in the same order, for the same reason.
   */
  readonly internalSecret: string;

  /** Injected so an export of unchanged content is byte-identical to the last one. */
  readonly now?: (() => Date) | undefined;

  /** How often a live socket's authorization is re-checked. */
  readonly reauthMs?: number | undefined;
  readonly rateWindow?: RateWindow | undefined;
  readonly newDocId?: (() => string) | undefined;
  readonly metrics?: CollabMetrics | undefined;
  readonly templates?: TemplateService | undefined;
  readonly importBodies?: ImportBodyService | undefined;
  readonly templateImportBodies?: TemplateImportBodyService | undefined;

  /** The document layer behind the sockets. Defaults to the handshake-only hub. */
  readonly hub?: SessionHub | undefined;
}

/**
 * The collaboration service's HTTP surface: catch up, append, and say whether it is alive.
 *
 * **Three endpoints, and every one of them is authorized by Core.** Nothing here decides
 * who may read or write a document; it forwards the caller's token and believes the answer.
 * That keeps one authorization code path in the system, which is the property that stops
 * two services drifting into disagreeing about the same permission.
 *
 * The transport is plain HTTP on purpose. A WebSocket, presence and live cursors are a
 * later phase and are an upgrade to *this same log* rather than a different design: the
 * socket will carry the same update payloads to the same table.
 */
export function createServer(deps: ServerDependencies): FastifyInstance {
  const app = Fastify({
    // Fastify's default is 1 MiB, which is exactly the update ceiling - leaving no room for
    // the JSON envelope around the payload. The refusal for an oversized update should be
    // this service's, with a code a client can act on, not the framework's generic one.
    bodyLimit: LIMITS.updateBytes * 2,
    // Silent under test: a suite whose assertions are buried in request logs is a suite
    // nobody reads the output of.
    logger:
      process.env.NODE_ENV === 'test'
        ? false
        : { level: process.env.NIX_COLLAB_LOG_LEVEL ?? 'info' },
  });

  const rateWindow = deps.rateWindow ?? new RateWindow();
  const newDocId = deps.newDocId ?? randomUUID;

  // The window and cache maps would otherwise grow by one entry per principal per document
  // for the process's lifetime. unref so a sweep timer never keeps the process alive.
  const sweeper = setInterval(() => {
    rateWindow.sweep();
    deps.sessions.sweep();
    deps.metrics?.authCacheSize.set(deps.sessions.size);
  }, LIMITS.windowMs);
  sweeper.unref();

  const hub = deps.hub ?? createHandshakeHub({ pool: deps.pool, newDocId });
  const wss = attachWebSocketServer(app.server, {
    sessions: deps.sessions,
    hub,
    reauthMs: deps.reauthMs ?? 60_000,
    metrics: deps.metrics,
  });

  // preClose, not onClose: Fastify only runs onClose once the HTTP server has closed its
  // connections, and an open WebSocket is one of those connections - draining there would
  // deadlock the shutdown against the very sockets it is trying to drain.
  app.addHook('preClose', async () => {
    clearInterval(sweeper);
    // Every client is told the truth - the server is going away - rather than watching a
    // socket die. 1012 is "service restarting", which tells a client to reconnect. The
    // hub drains after the sockets are told, which is the preStop story: final flushes
    // and snapshots land inside the termination grace period, not never.
    for (const client of wss.clients) {
      client.close(CLOSE_CODES.draining, 'The server is shutting down.');
    }
    await hub.shutdown?.();
    await new Promise<void>((resolve) => {
      wss.close(() => {
        resolve();
      });
    });
  });

  app.get('/healthz', () => ({ status: 'healthy', schema: describeSchema() }));

  const importBodies = deps.importBodies;
  if (importBodies !== undefined) {
    app.post(
      '/internal/imports/:importId/bodies',
      { bodyLimit: 16 * 1024 * 1024 },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const { importId } = request.params as { importId: string };
        const jobId = stringHeader(request, 'x-nix-worker-job-id');
        const executionId = stringHeader(request, 'x-nix-worker-execution-id');
        if (
          !internalCaller(request, deps) ||
          !isUuid(importId) ||
          jobId === null ||
          executionId === null
        ) {
          return problem(reply, 404, 'import_not_found', 'No such staged import is available.');
        }
        try {
          return await reply.send(
            await importBodies.write({
              importId,
              jobId,
              executionId,
              body: request.body,
            }),
          );
        } catch (error) {
          if (error instanceof CoreImportError) {
            return problem(reply, error.status, error.code, error.message);
          }
          const refusal = importBodyProblem(error);
          if (refusal !== null) {
            return problem(reply, refusal.status, refusal.code, refusal.message);
          }
          throw error;
        }
      },
    );
  }

  const templateImportBodies = deps.templateImportBodies;
  if (templateImportBodies !== undefined) {
    app.post(
      '/internal/worker-executions/template-imports/:importId/bodies',
      { bodyLimit: TEMPLATE_IMPORT_REQUEST_BYTES },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const { importId } = request.params as { importId: string };
        const jobId = stringHeader(request, 'x-nix-worker-job-id');
        const executionId = stringHeader(request, 'x-nix-worker-execution-id');
        if (
          !internalCaller(request, deps) ||
          !isUuid(importId) ||
          jobId === null ||
          executionId === null
        ) {
          return problem(
            reply,
            404,
            'template.import_not_found',
            'No such template import is available.',
          );
        }
        try {
          return await reply.send(
            await templateImportBodies.write({
              importId,
              jobId,
              executionId,
              body: request.body,
            }),
          );
        } catch (error) {
          if (error instanceof CoreTemplateImportError) {
            return problem(reply, error.status, error.code, error.message);
          }
          if (error instanceof TemplateImportBodyError) {
            return problem(reply, error.status, error.code, error.message);
          }
          throw error;
        }
      },
    );
  }

  if (deps.metrics !== undefined) {
    const metrics = deps.metrics;
    app.get('/metrics', async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.type(metrics.registry.contentType).send(await metrics.registry.metrics());
    });
  }

  if (deps.templates !== undefined) {
    const templates = deps.templates;

    app.get(
      '/templates/:templateId/export',
      async (request: FastifyRequest, reply: FastifyReply) => {
        const token = requestToken(request, reply);
        if (token === null) return reply;
        const { templateId } = request.params as { templateId: string };
        if (!isUuid(templateId)) {
          return problem(reply, 404, 'template_not_found', 'No such template.');
        }
        try {
          const prepared = await templates.exportTemplate(
            token,
            templateId,
            deps.now?.() ?? new Date(),
          );
          return await reply
            .type('application/zip')
            .header(
              'content-disposition',
              `attachment; filename="${exportFileName(prepared.title, 'nix')}"`,
            )
            .header('x-nix-export-items', String(prepared.manifest.items.length))
            .header('x-nix-export-omitted', '0')
            .header('x-nix-export-loss', '0')
            .send(Readable.from(writeArchive(prepared)));
        } catch (error) {
          return templateProblem(reply, error);
        }
      },
    );

    app.post('/templates/captures', async (request: FastifyRequest, reply: FastifyReply) => {
      const token = requestToken(request, reply);
      if (token === null) return reply;
      try {
        return await reply
          .code(201)
          .send(await templates.capture(token, parseCaptureRequest(request.body)));
      } catch (error) {
        return templateProblem(reply, error);
      }
    });

    app.post('/templates/applications', async (request: FastifyRequest, reply: FastifyReply) => {
      const token = requestToken(request, reply);
      if (token === null) return reply;
      try {
        return await reply
          .code(201)
          .send(await templates.apply(token, parseApplicationRequest(request.body)));
      } catch (error) {
        return templateProblem(reply, error);
      }
    });

    app.post(
      '/templates/:templateId/drafts',
      async (request: FastifyRequest, reply: FastifyReply) => {
        const token = requestToken(request, reply);
        if (token === null) return reply;
        const { templateId } = request.params as { templateId: string };
        if (!isUuid(templateId)) {
          return problem(
            reply,
            400,
            'template.draft_invalid',
            'A template ID and idempotency key are required.',
          );
        }
        try {
          const body = parseBeginDraftRequest(request.body);
          return await reply
            .code(201)
            .send(await templates.beginDraft(token, templateId, body.idempotencyKey));
        } catch (error) {
          return templateProblem(reply, error);
        }
      },
    );

    app.get(
      '/templates/:templateId/drafts/:operationId',
      async (request: FastifyRequest, reply: FastifyReply) => {
        const token = requestToken(request, reply);
        if (token === null) return reply;
        const { templateId, operationId } = request.params as {
          templateId: string;
          operationId: string;
        };
        if (!isUuid(templateId) || !isUuid(operationId)) {
          return problem(reply, 404, 'template_not_found', 'No such template draft.');
        }
        try {
          return await reply.send(await templates.getDraft(token, templateId, operationId));
        } catch (error) {
          return templateProblem(reply, error);
        }
      },
    );

    app.patch(
      '/templates/:templateId/drafts/:operationId',
      async (request: FastifyRequest, reply: FastifyReply) => {
        const token = requestToken(request, reply);
        if (token === null) return reply;
        const { templateId, operationId } = request.params as {
          templateId: string;
          operationId: string;
        };
        if (!isUuid(templateId) || !isUuid(operationId)) {
          return problem(reply, 404, 'template_not_found', 'No such template draft.');
        }
        try {
          return await reply.send(
            await templates.patchDraft(
              token,
              templateId,
              operationId,
              parseDraftMetadataPatch(request.body),
            ),
          );
        } catch (error) {
          return templateProblem(reply, error);
        }
      },
    );

    app.patch(
      '/templates/:templateId/drafts/:operationId/items/:sourceId',
      async (request: FastifyRequest, reply: FastifyReply) => {
        const token = requestToken(request, reply);
        if (token === null) return reply;
        const { templateId, operationId, sourceId } = request.params as {
          templateId: string;
          operationId: string;
          sourceId: string;
        };
        if (!isUuid(templateId) || !isUuid(operationId) || !isUuid(sourceId)) {
          return problem(reply, 404, 'template_not_found', 'No such template draft item.');
        }
        try {
          return await reply.send(
            await templates.patchDraftItem(
              token,
              templateId,
              operationId,
              sourceId,
              parseDraftItemPatch(request.body),
            ),
          );
        } catch (error) {
          return templateProblem(reply, error);
        }
      },
    );

    app.post(
      '/templates/:templateId/drafts/:operationId/save',
      async (request: FastifyRequest, reply: FastifyReply) => {
        const token = requestToken(request, reply);
        if (token === null) return reply;
        const { templateId, operationId } = request.params as {
          templateId: string;
          operationId: string;
        };
        if (!isUuid(templateId) || !isUuid(operationId)) {
          return problem(reply, 404, 'template_not_found', 'No such template draft.');
        }
        try {
          return await reply.send(await templates.saveDraft(token, templateId, operationId));
        } catch (error) {
          return templateProblem(reply, error);
        }
      },
    );

    app.delete(
      '/templates/:templateId/drafts/:operationId',
      async (request: FastifyRequest, reply: FastifyReply) => {
        const token = requestToken(request, reply);
        if (token === null) return reply;
        const { templateId, operationId } = request.params as {
          templateId: string;
          operationId: string;
        };
        if (!isUuid(templateId) || !isUuid(operationId)) {
          return problem(reply, 404, 'template_not_found', 'No such template draft.');
        }
        try {
          await templates.discardDraft(token, templateId, operationId);
          return await reply.code(204).send();
        } catch (error) {
          return templateProblem(reply, error);
        }
      },
    );

    app.post(
      '/templates/imports/validate',
      { bodyLimit: TEMPLATE_IMPORT_REQUEST_BYTES },
      async (request: FastifyRequest, reply: FastifyReply) => {
        if (!internalCaller(request, deps)) {
          return problem(reply, 404, 'template_not_found', 'No such template.');
        }
        const token = requestToken(request, reply);
        if (token === null) return reply;
        try {
          return await reply.send(
            await templates.validateImport(token, parseImportedTemplate(request.body)),
          );
        } catch (error) {
          return templateProblem(reply, error);
        }
      },
    );

    app.post(
      '/templates/imports',
      { bodyLimit: TEMPLATE_IMPORT_REQUEST_BYTES },
      async (request: FastifyRequest, reply: FastifyReply) => {
        if (!internalCaller(request, deps)) {
          return problem(reply, 404, 'template_not_found', 'No such template.');
        }
        const token = requestToken(request, reply);
        if (token === null) return reply;
        try {
          return await reply
            .code(201)
            .send(await templates.importTemplate(token, parseImportedTemplate(request.body)));
        } catch (error) {
          return templateProblem(reply, error);
        }
      },
    );

    app.post(
      '/templates/imports/stage',
      { bodyLimit: TEMPLATE_IMPORT_REQUEST_BYTES },
      async (request: FastifyRequest, reply: FastifyReply) => {
        if (!internalCaller(request, deps)) {
          return problem(reply, 404, 'template_not_found', 'No such template.');
        }
        const token = requestToken(request, reply);
        if (token === null) return reply;
        try {
          return await reply
            .code(202)
            .send(await templates.stageImport(token, parseImportedTemplate(request.body)));
        } catch (error) {
          return templateProblem(reply, error);
        }
      },
    );

    app.delete(
      '/templates/imports/:operationId',
      async (request: FastifyRequest, reply: FastifyReply) => {
        if (!internalCaller(request, deps)) {
          return problem(reply, 404, 'template_not_found', 'No such template.');
        }
        const token = requestToken(request, reply);
        if (token === null) return reply;
        const { operationId } = request.params as { operationId: string };
        if (!isUuid(operationId))
          return problem(reply, 404, 'template_not_found', 'No such template.');
        try {
          await templates.abortImport(token, operationId);
          return await reply.code(204).send();
        } catch (error) {
          return templateProblem(reply, error);
        }
      },
    );

    app.post(
      '/workspaces/:workspaceId/templates/managed/finalize',
      async (request: FastifyRequest, reply: FastifyReply) => {
        if (!internalCaller(request, deps)) {
          return problem(reply, 404, 'workspace_not_found', 'No such workspace.');
        }
        const token = requestToken(request, reply);
        if (token === null) return reply;
        const { workspaceId } = request.params as { workspaceId: string };
        if (!isUuid(workspaceId)) {
          return problem(
            reply,
            400,
            'template.finalize_invalid',
            'A workspace UUID, imports and activeStableKeys are required.',
          );
        }
        try {
          const body = parseManagedFinalizeRequest(request.body);
          return await reply.send(
            await templates.finalizeManaged(
              token,
              workspaceId,
              body.imports,
              body.activeStableKeys,
            ),
          );
        } catch (error) {
          return templateProblem(reply, error);
        }
      },
    );

    app.post(
      '/workspaces/:workspaceId/template-stages/expired/sweep',
      async (request: FastifyRequest, reply: FastifyReply) => {
        if (!internalCaller(request, deps)) {
          return problem(reply, 404, 'workspace_not_found', 'No such workspace.');
        }
        const token = requestToken(request, reply);
        if (token === null) return reply;
        const { workspaceId } = request.params as { workspaceId: string };
        if (!isUuid(workspaceId))
          return problem(reply, 404, 'workspace_not_found', 'No such workspace.');
        try {
          return await reply.send(await templates.sweepExpired(token, workspaceId));
        } catch (error) {
          return templateProblem(reply, error);
        }
      },
    );

    app.get(
      '/workspaces/:workspaceId/templates/import-authorization',
      async (request: FastifyRequest, reply: FastifyReply) => {
        if (!internalCaller(request, deps)) {
          return problem(reply, 404, 'workspace_not_found', 'No such workspace.');
        }
        const token = requestToken(request, reply);
        if (token === null) return reply;
        const { workspaceId } = request.params as { workspaceId: string };
        if (!isUuid(workspaceId))
          return problem(reply, 404, 'workspace_not_found', 'No such workspace.');
        try {
          return await reply.send(await templates.authorizeImport(token, workspaceId));
        } catch (error) {
          return templateProblem(reply, error);
        }
      },
    );
  }

  /**
   * The `.nix` archive: the lossless native format, served by the service that holds the bodies.
   *
   * **Collaboration's, not a converter's.** The lossless path must not depend on a lossy format
   * depend on an extension seam, and this process is the only one with both the document log and a
   * database credential - routing it through a converter service would copy every body over the
   * wire so a second process could re-zip it.
   */
  app.get('/documents/:itemId/export', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { scope?: string; format?: string };

    if (query.format !== undefined && query.format !== 'nix') {
      // A sentence rather than a 404: a client that asked the wrong service should be told which
      // one to ask, not left to guess whether the item exists.
      return problem(
        reply,
        400,
        'unsupported_format',
        'This service produces the .nix archive. PDF, Word, and Markdown exports are durable Go worker jobs started through Nix.Api.',
      );
    }

    const prepared = await establishExport(request, reply, deps, query.scope);
    if (prepared === null) {
      return reply;
    }

    const name = exportFileName(prepared.root.title, 'nix');

    return exportHeaders(reply, prepared, 'application/zip', name).send(
      Readable.from(writeArchive({ manifest: prepared.manifest, bundles: prepared.bundles })),
    );
  });

  /**
   * The same export, as bundles, for a converter in another process. [SEC]
   *
   * **Two facts authorize this, and both are required.** The shared secret says which service is
   * calling; the forwarded bearer says on whose behalf, and it goes through the same `establish`
   * every other route uses - so the Go export worker holds no authority of its own and there is still
   * one authorization code path. A wrong or missing secret answers 404 rather than 403, matching
   * Core's internal surface: a browser that stumbles onto this URL learns nothing from it.
   */
  app.get('/documents/:itemId/bundles', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!internalCaller(request, deps)) {
      return problem(reply, 404, 'document_not_found', 'No such item.');
    }

    const query = request.query as { scope?: string; exportedAt?: string; expandEmbeds?: string };
    const prepared = await establishExport(
      request,
      reply,
      deps,
      query.scope,
      query.exportedAt,
      query.expandEmbeds === 'true',
    );
    if (prepared === null) {
      return reply;
    }

    return exportHeaders(reply, prepared, STREAM_MEDIA_TYPE, null).send(
      Readable.from(writeBundleStream({ manifest: prepared.manifest, bundles: prepared.bundles })),
    );
  });

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

  return app;
}

/**
 * Whether this request came from a service holding the internal secret.
 *
 * Caddy deliberately proxies the whole `/collab/*` prefix, including these internal routes, so
 * routing is not an authorization boundary. Compare fixed-size digests to avoid both a secret
 * length branch and an unequal-buffer timing path. Callers above return the same 404 for a missing
 * or incorrect secret before they perform endpoint work.
 */
function internalCaller(request: FastifyRequest, deps: ServerDependencies): boolean {
  const supplied = request.headers['x-nix-internal-secret'];
  const candidate = typeof supplied === 'string' ? supplied : '';
  const expectedDigest = createHash('sha256').update(deps.internalSecret, 'utf8').digest();
  const candidateDigest = createHash('sha256').update(candidate, 'utf8').digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}

function stringHeader(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null;
}

function requestToken(request: FastifyRequest, reply: FastifyReply): string | null {
  const token = bearer(request.headers.authorization);
  if (token === null) {
    problem(reply, 401, 'unauthenticated', 'A bearer token is required.');
  }
  return token;
}

function templateProblem(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof TemplateHttpContractError) {
    return problem(reply, error.status, error.code, error.message);
  }
  if (error instanceof CoreTemplateError) {
    return problem(reply, error.status, error.code, error.message);
  }
  if (error instanceof TemplateBodyError) {
    return problem(reply, 422, error.code, error.message);
  }
  throw error;
}

/**
 * Authorizes an export and walks its tree, or writes the refusal and returns null.
 *
 * Shared by both export routes so the two can never disagree about who may export what, or about
 * what an export of one item contains.
 */
async function establishExport(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: ServerDependencies,
  rawScope: string | undefined,
  rawExportedAt?: string,
  expandEmbeds = false,
): Promise<PreparedExport | null> {
  const context = await establish(request, reply, deps);
  if (context === null) {
    return null;
  }

  const scope = readScope(rawScope ?? 'item');
  if (scope === null) {
    problem(reply, 400, 'invalid_scope', "'scope' must be 'item' or 'subtree'.");
    return null;
  }

  const exportedAt =
    rawExportedAt === undefined ? (deps.now?.() ?? new Date()) : readExportedAt(rawExportedAt);
  if (exportedAt === null) {
    problem(
      reply,
      400,
      'invalid_exported_at',
      "'exportedAt' must be a bounded RFC 3339 timestamp.",
    );
    return null;
  }

  const token = bearer(request.headers.authorization);
  if (token === null) {
    problem(reply, 401, 'unauthenticated', 'A bearer token is required.');
    return null;
  }

  // No tenant scope is opened here. The tree is walked against Core, as the caller, and the scope
  // is opened by the bundle stream itself and held for as long as it is being read - so a refused
  // export never reaches the database, and no transaction is held open across a Core round trip.
  const prepared = await prepareExport({
    core: deps.core,
    pool: deps.pool,
    tenant: context.scope,
    token,
    itemId: context.itemId,
    scope,
    includeDeleted: false,
    expandEmbeds,
    exportedAt,
  });

  if (prepared === null) {
    problem(reply, 404, 'document_not_found', 'No such item.');
    return null;
  }

  return prepared;
}

/**
 * The headers an export answers with, set before the first byte.
 *
 * The counts come from the manifest, which is complete before any body is read - so a client knows
 * how much it is getting and how much was left out without unpacking what it is about to save.
 */
function exportHeaders(
  reply: FastifyReply,
  prepared: PreparedExport,
  mediaType: string,
  fileName: string | null,
): FastifyReply {
  const withCounts = reply
    .type(mediaType)
    .header('x-nix-export-items', String(prepared.manifest.items.length))
    .header('x-nix-export-omitted', String(prepared.manifest.omitted.length))
    // Zero, and the zero is the claim: `.nix` is the lossless format, and a bundle stream has lost
    // nothing either - whatever the converter reading it goes on to lose is its own to declare.
    .header('x-nix-export-loss', '0');

  return fileName === null
    ? withCounts
    : withCounts.header('content-disposition', `attachment; filename="${fileName}"`);
}

interface RequestContext {
  readonly itemId: string;
  readonly workspaceId: string;
  readonly canWrite: boolean;
  readonly bodyKind: string;
  readonly scope: { tenantId: string; principalId: string };
}

/**
 * Authenticates, then authorizes, then produces the tenant scope the work runs under.
 *
 * Writes the refusal onto the reply and returns null when either step fails, so callers
 * branch once. **The tenant is Core's answer, never the request's** - a client-supplied
 * tenant would be a second source of truth for the fact the isolation policies stand on.
 */
async function establish(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: ServerDependencies,
): Promise<RequestContext | null> {
  const token = bearer(request.headers.authorization);
  if (token === null) {
    problem(reply, 401, 'unauthenticated', 'A bearer token is required.');
    return null;
  }

  const { itemId } = request.params as { itemId: string };
  if (!isUuid(itemId)) {
    // Not-found rather than a validation error, to match Core: a malformed identifier and
    // an identifier for something the caller may not see get the same answer.
    problem(reply, 404, 'document_not_found', 'No such item.');
    return null;
  }

  const result = await deps.sessions.authenticate(token, itemId);
  if (!result.ok) {
    if (result.reason === 'unauthenticated') {
      problem(reply, 401, 'unauthenticated', 'The token could not be validated.');
    } else {
      problem(reply, 404, 'document_not_found', 'No such item.');
    }
    return null;
  }

  const authorization = result.value;
  return {
    itemId,
    workspaceId: authorization.workspaceId,
    canWrite: authorization.canWrite,
    bodyKind: authorization.bodyKind,
    scope: { tenantId: authorization.tenantId, principalId: authorization.principalId },
  };
}

function bearer(header: string | undefined): string | null {
  if (!header?.toLowerCase().startsWith('bearer ')) {
    return null;
  }

  const token = header.slice('bearer '.length).trim();
  return token.length > 0 ? token : null;
}

function problem(reply: FastifyReply, status: number, code: string, detail: string): FastifyReply {
  // The same shape Core uses, so a client has one error handler rather than two: RFC 9457
  // with a stable `code` extension that clients switch on instead of message text.
  return reply
    .code(status)
    .type('application/problem+json')
    .send({ type: 'about:blank', title: 'Request refused', status, code, detail });
}

function parseSeq(value: string | undefined): bigint | null {
  if (value === undefined) {
    return 0n;
  }

  if (!/^\d+$/.test(value)) {
    return null;
  }

  return BigInt(value);
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeBase64(value: string): Uint8Array | null {
  // Checked before decoding, because `Buffer.from(..., 'base64')` silently drops characters
  // it cannot parse rather than failing. A payload with a typo in it would otherwise decode
  // to a shorter buffer, be applied as a Yjs update, and either corrupt the document or
  // produce a refusal that blames the wrong thing.
  if (value.length % 4 !== 0 || !BASE64.test(value)) {
    return null;
  }

  return new Uint8Array(Buffer.from(value, 'base64'));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID.test(value);
}
