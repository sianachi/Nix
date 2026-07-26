import { randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

import type { Authorizer } from '../auth/authorize.ts';
import type { TokenValidator } from '../auth/token.ts';
import { withTenantScope } from '../db/tenant-scope.ts';
import { LIMITS, rejection } from '../documents/limits.ts';
import { RateWindow } from '../documents/limits.ts';
import { CATCH_UP_LIMIT, applyUpdate, describeSchema, openDocument } from '../documents/service.ts';
import { updatesAfter } from '../db/documents.ts';

export interface ServerDependencies {
  readonly pool: Pool;
  readonly tokens: TokenValidator;
  readonly authorizer: Authorizer;
  readonly snapshotEvery: number;
  readonly rateWindow?: RateWindow;
  readonly newDocId?: () => string;
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

  // The window map would otherwise grow by one entry per principal per document for the
  // process's lifetime. unref so a sweep timer never keeps the process alive.
  const sweeper = setInterval(() => {
    rateWindow.sweep();
  }, LIMITS.windowMs);
  sweeper.unref();
  app.addHook('onClose', () => {
    clearInterval(sweeper);
  });

  app.get('/healthz', () => ({ status: 'healthy', schema: describeSchema() }));

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
        snapshotEvery: deps.snapshotEvery,
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

interface RequestContext {
  readonly itemId: string;
  readonly workspaceId: string;
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

  const validated = await deps.tokens.validate(token);
  if (validated === null) {
    problem(reply, 401, 'unauthenticated', 'The token could not be validated.');
    return null;
  }

  const { itemId } = request.params as { itemId: string };
  if (!isUuid(itemId)) {
    // Not-found rather than a validation error, to match Core: a malformed identifier and
    // an identifier for something the caller may not see get the same answer.
    problem(reply, 404, 'document_not_found', 'No such item.');
    return null;
  }

  const authorization = await deps.authorizer.authorize(token, itemId);
  if (authorization === null) {
    problem(reply, 404, 'document_not_found', 'No such item.');
    return null;
  }

  return {
    itemId,
    workspaceId: authorization.workspaceId,
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
