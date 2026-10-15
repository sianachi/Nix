import type { FastifyInstance } from 'fastify';

import { findDocByItem } from '../../db/documents.ts';
import { withTenantScope, type TenantScope } from '../../db/tenant-scope.ts';
import { noteStrategy, strategyFor } from '../../documents/body-kinds.ts';
import { loadDocument } from '../../documents/service.ts';
import { internalCaller } from '../auth.ts';
import type { RouteDependencies } from '../context.ts';
import { isUuid } from '../params.ts';
import { problem } from '../replies.ts';

export const CONVERSATION_BODY_LIMIT = 24_000;

interface BodyRequest extends TenantScope {
  conversationId: string;
  requestId: string;
  workspaceId: string;
  itemId: string;
}

interface BodyAuthorization extends TenantScope {
  workspaceId: string;
  bodyKind: string;
}

export interface ConversationBodyAuthorizer {
  authorize(request: BodyRequest): Promise<BodyAuthorization | 'locked' | 'unavailable' | null>;
}

// The secret authenticates the service; the persisted running turn authenticates its authority.
export function createConversationBodyAuthorizer(options: {
  coreBaseUrl: string;
  internalSecret: string;
  fetch?: typeof globalThis.fetch;
}): ConversationBodyAuthorizer {
  const doFetch = options.fetch ?? globalThis.fetch;
  return {
    async authorize(request) {
      try {
        const response = await doFetch(
          `${options.coreBaseUrl}/internal/conversations/${request.conversationId}/tools`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-nix-internal-secret': options.internalSecret,
            },
            body: JSON.stringify({
              tenantId: request.tenantId,
              principalId: request.principalId,
              requestId: request.requestId,
              arguments: {
                operation: 'authorize_body',
                workspaceId: request.workspaceId,
                itemId: request.itemId,
              },
            }),
            signal: AbortSignal.timeout(5_000),
          },
        );
        if (response.status >= 500 || response.status === 429) return 'unavailable';
        if (!response.ok) return null;
        const answer: unknown = await response.json();
        if (typeof answer !== 'object' || answer === null) return null;
        if ('lockedContent' in answer && answer.lockedContent === true) return 'locked';
        if (
          !('success' in answer) ||
          answer.success !== true ||
          !('result' in answer) ||
          typeof answer.result !== 'string'
        )
          return null;
        const grant: unknown = JSON.parse(answer.result);
        if (
          typeof grant !== 'object' ||
          grant === null ||
          !('tenantId' in grant) ||
          grant.tenantId !== request.tenantId ||
          !('principalId' in grant) ||
          grant.principalId !== request.principalId ||
          !('workspaceId' in grant) ||
          grant.workspaceId !== request.workspaceId ||
          !('bodyKind' in grant) ||
          typeof grant.bodyKind !== 'string'
        )
          return null;
        return {
          tenantId: request.tenantId,
          principalId: request.principalId,
          workspaceId: request.workspaceId,
          bodyKind: grant.bodyKind,
        };
      } catch {
        return 'unavailable';
      }
    },
  };
}

export function registerConversationBodyRoutes(
  app: FastifyInstance,
  deps: Pick<RouteDependencies, 'pool' | 'internalSecret' | 'conversationBodyAuthorizer'>,
): void {
  app.post<{ Params: { conversationId: string }; Body: unknown }>(
    '/internal/conversations/:conversationId/body',
    async (request, reply) => {
      if (!internalCaller(request, deps.internalSecret)) {
        return problem(reply, 404, 'document_not_found', 'No such item.');
      }
      const body = request.body;
      const conversationId = request.params.conversationId;
      if (
        !isUuid(conversationId) ||
        typeof body !== 'object' ||
        body === null ||
        !('tenantId' in body) ||
        typeof body.tenantId !== 'string' ||
        !isUuid(body.tenantId) ||
        !('principalId' in body) ||
        typeof body.principalId !== 'string' ||
        !isUuid(body.principalId) ||
        !('workspaceId' in body) ||
        typeof body.workspaceId !== 'string' ||
        !isUuid(body.workspaceId) ||
        !('itemId' in body) ||
        typeof body.itemId !== 'string' ||
        !isUuid(body.itemId) ||
        !('requestId' in body) ||
        typeof body.requestId !== 'string' ||
        !isUuid(body.requestId)
      ) {
        return problem(
          reply,
          400,
          'invalid_request',
          'A running conversation request is required.',
        );
      }
      const authorization = await deps.conversationBodyAuthorizer?.authorize({
        conversationId,
        tenantId: body.tenantId,
        principalId: body.principalId,
        workspaceId: body.workspaceId,
        itemId: body.itemId,
        requestId: body.requestId,
      });
      if (authorization === undefined || authorization === 'unavailable') {
        return problem(reply, 503, 'authorization_unavailable', 'Access could not be confirmed.');
      }
      if (authorization === 'locked') {
        return problem(reply, 403, 'body_locked', 'Unlock this body before reading it.');
      }
      if (authorization === null) {
        return problem(reply, 404, 'document_not_found', 'No such item.');
      }
      if (strategyFor(authorization.bodyKind) !== noteStrategy) {
        return { text: '', truncated: false, unsupported: true };
      }
      const itemId = body.itemId;
      const result = await withTenantScope(deps.pool, authorization, async (sql) => {
        const document = await findDocByItem(sql, authorization.tenantId, itemId);
        if (document === null) return { text: '', truncated: false, unsupported: false };
        if (document.workspace_id !== authorization.workspaceId) {
          return { error: 'not_found' };
        }
        const state = await loadDocument(sql, authorization.tenantId, document);
        try {
          const materialized = noteStrategy.materialize(state);
          if (materialized.json === null) {
            return { error: 'unreadable' };
          }
          return {
            text: materialized.plaintext.slice(0, CONVERSATION_BODY_LIMIT),
            truncated: materialized.plaintext.length > CONVERSATION_BODY_LIMIT,
            unsupported: false,
          };
        } finally {
          state.destroy();
        }
      });
      if ('error' in result) {
        return result.error === 'not_found'
          ? problem(reply, 404, 'document_not_found', 'No such item.')
          : problem(reply, 409, 'document_unreadable', 'This body cannot be read by this build.');
      }
      return result;
    },
  );
}
