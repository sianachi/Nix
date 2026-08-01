import type { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import type { Authorizer } from '../auth/authorize.ts';
import type { TokenValidator } from '../auth/token.ts';
import { createSessionAuthenticator } from '../ws/session-auth.ts';
import { createServer } from './server.ts';

/**
 * The HTTP surface's refusals, with no database behind it.
 *
 * Every test here is about a request that must never reach Postgres: no token, a token that
 * does not validate, an item Core refused, or a writer who is only a reader. The pool is a
 * proxy that throws if anything touches it, so "did not reach the database" is asserted
 * rather than assumed.
 */

const ITEM = 'c1000000-0000-4000-8000-000000000031';

const GRANTED = {
  tenantId: 'c1000000-0000-4000-8000-000000000001',
  principalId: 'c1000000-0000-4000-8000-000000000021',
  workspaceId: 'c1000000-0000-4000-8000-000000000011',
  canWrite: true,
  bodyKind: 'note',
} as const;

/** A pool that fails loudly. Reaching it at all is the bug these tests look for. */
const refusingPool = new Proxy({} as Pool, {
  get() {
    throw new Error('The request reached the database, which it should have been refused before.');
  },
});

function server(overrides: { tokens?: TokenValidator; authorizer?: Authorizer; pool?: Pool }) {
  return createServer({
    pool: overrides.pool ?? refusingPool,
    sessions: createSessionAuthenticator({
      tokens: overrides.tokens ?? {
        validate: () => Promise.resolve({ subject: 'subject', expiresAt: null }),
      },
      authorizer: overrides.authorizer ?? { authorize: () => Promise.resolve(null) },
    }),
    snapshotEvery: 0,
  });
}

const instances: { close: () => Promise<unknown> }[] = [];

function track<T extends { close: () => Promise<unknown> }>(app: T): T {
  instances.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(instances.splice(0).map((app) => app.close()));
});

describe('the collaboration service HTTP surface', () => {
  it('reports its schema version on the health endpoint', async () => {
    const app = track(server({}));

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'healthy' });
  });

  it('refuses a request with no bearer token', async () => {
    const app = track(server({}));

    const response = await app.inject({ method: 'GET', url: `/documents/${ITEM}/updates` });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'unauthenticated' });
  });

  it('refuses a token that does not validate', async () => {
    const app = track(server({ tokens: { validate: () => Promise.resolve(null) } }));

    const response = await app.inject({
      method: 'GET',
      url: `/documents/${ITEM}/updates`,
      headers: { authorization: 'Bearer forged' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('reports an item Core refused as not found, never as forbidden', async () => {
    const app = track(server({ authorizer: { authorize: () => Promise.resolve(null) } }));

    const response = await app.inject({
      method: 'GET',
      url: `/documents/${ITEM}/updates`,
      headers: { authorization: 'Bearer valid' },
    });

    // Matching Core exactly. "You may not see this" confirms the thing exists, which is how
    // an outsider enumerates a workspace one identifier at a time.
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'document_not_found' });
  });

  it('refuses a malformed item identifier the same way', async () => {
    const app = track(server({}));

    const response = await app.inject({
      method: 'GET',
      url: '/documents/not-a-uuid/updates',
      headers: { authorization: 'Bearer valid' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('never asks Core about an item when the token is bad', async () => {
    let asked = 0;
    const app = track(
      server({
        tokens: { validate: () => Promise.resolve(null) },
        authorizer: {
          authorize: () => {
            asked += 1;
            return Promise.resolve(null);
          },
        },
      }),
    );

    await app.inject({
      method: 'POST',
      url: `/documents/${ITEM}/updates`,
      headers: { authorization: 'Bearer forged' },
      payload: { update: 'AAAA', clientId: 'client' },
    });

    // Authentication first, then authorization. Reversed, an unauthenticated caller could
    // make this service hammer Core on their behalf.
    expect(asked).toBe(0);
  });

  it('refuses a write from a principal Core says may only read', async () => {
    const app = track(
      server({
        authorizer: { authorize: () => Promise.resolve({ ...GRANTED, canWrite: false }) },
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: `/documents/${ITEM}/updates`,
      headers: { authorization: 'Bearer valid' },
      payload: { update: 'AAAA', clientId: 'client' },
    });

    // Forbidden rather than not-found: a reader already knows the item exists, and "you may
    // see this and not change it" is the answer they can act on. The pool proxy guarantees
    // the refused write never reached the log.
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'read_only' });
  });

  it('still lets a reader catch up on a document they may not write', async () => {
    // Reads reach the database, so this needs a pool - but the refusal under test happens
    // before that. A reader hitting 'read_only' on GET would be the bug.
    let touchedPool = false;
    const observingPool = new Proxy({} as Pool, {
      get() {
        touchedPool = true;
        throw new Error('stop here; the authorization already passed');
      },
    });

    const app = track(
      server({
        pool: observingPool,
        authorizer: { authorize: () => Promise.resolve({ ...GRANTED, canWrite: false }) },
      }),
    );

    const response = await app.inject({
      method: 'GET',
      url: `/documents/${ITEM}/updates`,
      headers: { authorization: 'Bearer valid' },
    });

    expect(touchedPool).toBe(true);
    expect(response.statusCode).not.toBe(403);
  });

  it('refuses a body that is not an update at all', async () => {
    const app = track(server({ authorizer: { authorize: () => Promise.resolve(GRANTED) } }));

    const response = await app.inject({
      method: 'POST',
      url: `/documents/${ITEM}/updates`,
      headers: { authorization: 'Bearer valid' },
      payload: { nonsense: true },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'invalid_body' });
  });

  it('refuses an update that is not valid base64 before decoding it', async () => {
    const app = track(server({ authorizer: { authorize: () => Promise.resolve(GRANTED) } }));

    // Buffer.from silently drops what it cannot parse, so a payload with a typo would
    // otherwise decode to a shorter buffer and be applied as though it were what was sent.
    const response = await app.inject({
      method: 'POST',
      url: `/documents/${ITEM}/updates`,
      headers: { authorization: 'Bearer valid' },
      payload: { update: 'not base64 at all!!', clientId: 'client' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses a cursor that is not a sequence', async () => {
    const app = track(server({ authorizer: { authorize: () => Promise.resolve(GRANTED) } }));

    const response = await app.inject({
      method: 'GET',
      url: `/documents/${ITEM}/updates?after=yesterday`,
      headers: { authorization: 'Bearer valid' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'invalid_cursor' });
  });

  it('serves metrics when given a registry', async () => {
    const { createMetrics } = await import('../metrics.ts');
    const app = track(
      createServer({
        pool: refusingPool,
        sessions: createSessionAuthenticator({
          tokens: { validate: () => Promise.resolve(null) },
          authorizer: { authorize: () => Promise.resolve(null) },
        }),
        snapshotEvery: 0,
        metrics: createMetrics(),
      }),
    );

    const response = await app.inject({ method: 'GET', url: '/metrics' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('nix_collab_open_sockets');
  });
});
