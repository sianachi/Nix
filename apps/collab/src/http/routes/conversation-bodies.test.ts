import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import {
  registerConversationBodyRoutes,
  createConversationBodyAuthorizer,
  type ConversationBodyAuthorizer,
} from './conversation-bodies.ts';
import { TENANTS } from '../../db/testing.ts';

const tenant = TENANTS.alpha;
const request = {
  tenantId: tenant.tenantId,
  principalId: tenant.principalId,
  workspaceId: tenant.workspaceId,
  itemId: tenant.itemId,
  requestId: tenant.docId,
};
const grant = { ...request, bodyKind: 'note' };
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function server(authorizer: ConversationBodyAuthorizer) {
  const app = Fastify();
  const deps = {
    internalSecret: 'secret',
    conversationBodyAuthorizer: authorizer,
    pool: new Proxy({} as Pool, {
      get() {
        throw new Error('Unauthorized database access');
      },
    }),
  };
  registerConversationBodyRoutes(app, deps);
  apps.push(app);
  return app;
}

const url = `/internal/conversations/${tenant.targetItemId}/body`;

describe('conversation body authorization', () => {
  it('does not authorize or read without the service secret', async () => {
    const response = await server({
      authorize() {
        throw new Error('must not authorize');
      },
    }).inject({ method: 'POST', url, payload: request });
    expect(response.statusCode).toBe(404);
  });

  it.each([
    [null, 404],
    ['locked', 403],
    ['unavailable', 503],
  ] as const)('refuses %s before reading a document', async (result, status) => {
    const response = await server({ authorize: () => Promise.resolve(result) }).inject({
      method: 'POST',
      url,
      payload: request,
      headers: { 'x-nix-internal-secret': 'secret' },
    });
    expect(response.statusCode).toBe(status);
  });

  it('reports unsupported body kinds without treating them as empty prose', async () => {
    const response = await server({
      authorize: () => Promise.resolve({ ...grant, bodyKind: 'canvas' }),
    }).inject({
      method: 'POST',
      url,
      payload: request,
      headers: { 'x-nix-internal-secret': 'secret' },
    });
    expect(response.json()).toEqual({ text: '', truncated: false, unsupported: true });
  });

  it('reauthorizes the exact durable turn, actor, source workspace and item through Core', async () => {
    let sent: unknown;
    const authorizer = createConversationBodyAuthorizer({
      coreBaseUrl: 'http://core',
      internalSecret: 'secret',
      fetch: (_url, init) => {
        if (typeof init?.body !== 'string') throw new Error('Expected JSON request');
        sent = JSON.parse(init.body);
        return Promise.resolve(
          Response.json({ success: true, result: JSON.stringify(grant), lockedContent: false }),
        );
      },
    });
    expect(
      await authorizer.authorize({ ...request, conversationId: tenant.targetItemId }),
    ).toMatchObject({
      tenantId: tenant.tenantId,
      principalId: tenant.principalId,
      workspaceId: tenant.workspaceId,
      bodyKind: 'note',
    });
    expect(sent).toEqual({
      tenantId: tenant.tenantId,
      principalId: tenant.principalId,
      requestId: tenant.docId,
      arguments: {
        operation: 'authorize_body',
        workspaceId: tenant.workspaceId,
        itemId: tenant.itemId,
      },
    });
  });

  it('preserves Core locked-content refusals on the callback', async () => {
    const authorizer = createConversationBodyAuthorizer({
      coreBaseUrl: 'http://core',
      internalSecret: 'secret',
      fetch: () =>
        Promise.resolve(Response.json({ success: false, result: '', lockedContent: true })),
    });
    expect(await authorizer.authorize({ ...request, conversationId: tenant.targetItemId })).toBe(
      'locked',
    );
  });

  it('refuses an authorization response for a different tenant', async () => {
    const authorizer = createConversationBodyAuthorizer({
      coreBaseUrl: 'http://core',
      internalSecret: 'secret',
      fetch: () =>
        Promise.resolve(
          Response.json({
            success: true,
            result: JSON.stringify({ ...grant, tenantId: TENANTS.beta.tenantId }),
            lockedContent: false,
          }),
        ),
    });
    expect(
      await authorizer.authorize({ ...request, conversationId: tenant.targetItemId }),
    ).toBeNull();
  });
});
